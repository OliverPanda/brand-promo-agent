// M2 集成测试：真实 Provider 经 mock fetch 跑通两段式工作流，并验证 FR-10 成本归集 + 预算闸门。
// 关键：必须在 import server.js（其依赖链加载 cost.js 读取 PROMO_BUDGET_CAP）前设置环境变量。
process.env.STEP_DELAY_MS = "10";
process.env.PROMO_PROVIDER_MODE = "real";
process.env.PROMO_ONEAPI_BASE_URL = "https://one-api.example/v1";
process.env.PROMO_ONEAPI_API_KEY = "sk-test-xxxx";
process.env.PROMO_LLM_MODEL = "deepseek-v4-flash";
process.env.PROMO_IMAGE_MODEL = "doubao-seedream-4-0-250828";
process.env.PROMO_IMAGE_SIZE = "1024x576";
process.env.PROMO_TTS_MODEL = "speech-02-hd";
process.env.PROMO_MUSIC_MODEL = "mureka-v1";
process.env.PROMO_MUSIC_PATH = "/audio/music";
process.env.PROMO_BUDGET_CAP = "100"; // 充足预算，确保成功路径
process.env.PROMO_FFMPEG_BIN = process.env.PROMO_FFMPEG_BIN || "ffmpeg";
process.env.PROMO_FFPROBE_BIN = process.env.PROMO_FFPROBE_BIN || "ffprobe";

const { test } = await import("node:test");
const assert = (await import("node:assert/strict")).default;

// ── fetch mock（与 providers-real 同形）──
function makeRes({ ok = true, status = 200, json, text, bytes } = {}) {
  return {
    ok,
    status,
    json: async () => json,
    text: async () => text ?? "",
    arrayBuffer: async () => (bytes ? Buffer.from(bytes) : Buffer.alloc(0)),
  };
}
function route(path, body) {
  if (path.endsWith("/models")) {
    return makeRes({ json: { data: [
      { id: "minimax-h3", type: "video" },
      { id: "speech-02-hd", type: "tts" },
      { id: "mureka-v1", type: "music" },
    ] } });
  }
  if (path.endsWith("/chat/completions")) {
    const sys = body.messages?.[0]?.content || "";
    if (sys.includes("资深品牌文案")) {
      return makeRes({ json: { choices: [{ message: { content: JSON.stringify({
        title: "T", voiceover: [{ timecode: "00:00:00.000", text: "hi" }], structure: ["a"], moodCurve: ["x"],
      }) } }], usage: { total_tokens: 120 } } });
    }
    return makeRes({ json: { choices: [{ message: { content: JSON.stringify({ scenes: [
      { index: 1, visualPrompt: "p1", subtitle: "s1", camera: "push", durationSec: 5, musicClimax: false },
      { index: 2, visualPrompt: "p2", subtitle: "s2", camera: "pull", durationSec: 5, musicClimax: true },
    ] }) } }], usage: { total_tokens: 200 } } });
  }
  if (path.endsWith("/images/generations")) return makeRes({ json: { data: [{ url: "https://cdn.example/scene.png" }] } });
  if (path.endsWith("/audio/speech")) return makeRes({ bytes: [0x49, 0x44, 0x33, 0x03] });
  if (path.endsWith("/audio/music")) return makeRes({ json: { data: [{ url: "https://cdn.example/bgm.mp3" }] } });
  return makeRes({ ok: false, status: 404, text: "not found" });
}
// 关键：只把 one-api 域名的请求路由到 mock；localhost（测试用 HTTP 客户端 / SSE）走真实 fetch。
const realFetch = globalThis.fetch?.bind(globalThis);
globalThis.fetch = async (url, opts = {}) => {
  const u = typeof url === "string" ? url : String(url);
  if (u.includes("127.0.0.1") || u.includes("localhost")) {
    return realFetch(url, opts);
  }
  return route(u.replace(/^https?:\/\/[^/]+/, ""), opts?.body ? JSON.parse(opts.body) : undefined);
};

const { app } = await import("../src/server.js");

const BASE = (port) => `http://127.0.0.1:${port}`;
const waitStatus = async (port, runId, statuses, timeoutMs = 20000) => {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const r = await fetch(`${BASE(port)}/api/runs/${runId}`);
    if (r.ok) {
      const run = await r.json();
      if (statuses.includes(run.status)) return run;
    }
    await new Promise((r) => setTimeout(r, 30));
  }
  throw new Error(`run ${runId} 未在 ${timeoutMs}ms 内进入 ${statuses}`);
};

const baseBrief = {
  brandName: "铭星科技",
  productName: "星链 Pro",
  coreSellingPoint: "一句话生成专业宣传片",
  tones: ["科技感"],
  durationSec: 30,
  language: "zh-CN",
  voiceTone: "男声",
};

test("真实模式 + 充足预算：端到端成功并归集 cost（≥5 步）", async () => {
  const server = app.listen(0);
  const port = server.address().port;
  try {
    const r = await fetch(`${BASE(port)}/api/generate`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...baseBrief, hitlEnabled: false, finalGateEnabled: false }),
    });
    assert.equal(r.status, 200);
    const { runId } = await r.json();
    const run = await waitStatus(port, runId, ["success", "failed"]);
    assert.equal(run.status, "success", `应成功，实际=${run.status}，note=${run.note}`);
    assert.ok(Array.isArray(run.storyboardGallery) && run.storyboardGallery.length >= 2, "应产出分镜画廊");
    assert.ok(run.cost && run.cost.length >= 5, `应归集 ≥5 步成本，实际=${run.cost?.length}`);
    // 各步金额计算正确
    const byStep = Object.fromEntries(run.cost.map((c) => [c.step, c.amount]));
    assert.ok(byStep.writeScript > 0, "writeScript 应计成本");
    assert.ok(byStep.generateScenes > 0, "generateScenes 应计成本（图像）");
    assert.ok(byStep.music > 0, "music 应计成本（曲目）");
    assert.equal(typeof byStep.composite, "undefined", "无 ffmpeg 时 composite 不计成本（降级）");
  } finally {
    server.close();
  }
});

test("真实模式 + 极小预算：首步即触发 BudgetExceededError，run=failed 且 cost 已记录一条", async () => {
  process.env.PROMO_BUDGET_CAP = "0.0001"; // 120 tokens → ¥0.00048 > 上限
  const server = app.listen(0);
  const port = server.address().port;
  try {
    const r = await fetch(`${BASE(port)}/api/generate`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...baseBrief, hitlEnabled: false }),
    });
    const { runId } = await r.json();
    const run = await waitStatus(port, runId, ["failed"]);
    assert.equal(run.status, "failed");
    assert.ok(run.cost && run.cost.length === 1, "超限前已记录一条成本");
    const step = run.steps.writeScript;
    assert.equal(step?.status, "failed");
    assert.match(String(step?.error || ""), /预算超限/);
  } finally {
    process.env.PROMO_BUDGET_CAP = "100";
    server.close();
  }
});

test("真实模式 + 极小配额：首步即触发 QuotaExceededError，run=failed 且 cost 已记录一条", async () => {
  process.env.PROMO_QUOTA_CAP = "0.0001"; // 已用(前序测试累计) + 120 tokens≈¥0.00048 > 上限
  const server = app.listen(0);
  const port = server.address().port;
  try {
    const r = await fetch(`${BASE(port)}/api/generate`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...baseBrief, hitlEnabled: false, finalGateEnabled: false }),
    });
    const { runId } = await r.json();
    const run = await waitStatus(port, runId, ["failed"]);
    assert.equal(run.status, "failed");
    assert.ok(run.cost && run.cost.length === 1, "超限前已记录一条成本");
    const step = run.steps.writeScript;
    assert.equal(step?.status, "failed");
    assert.match(String(step?.error || ""), /配额超限/);
  } finally {
    process.env.PROMO_QUOTA_CAP = "200";
    server.close();
  }
});

test("GET /api/config 在真实模式返回 one-api provider 与预算上限", async () => {
  const server = app.listen(0);
  const port = server.address().port;
  try {
    const r = await fetch(`${BASE(port)}/api/config`);
    const cfg = await r.json();
    assert.equal(cfg.mode, "real");
    assert.equal(cfg.provider, "one-api");
    assert.equal(cfg.budgetCap, 100);
  } finally {
    server.close();
  }
});
