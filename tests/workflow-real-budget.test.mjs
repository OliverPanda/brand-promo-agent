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

const fs = (await import("node:fs")).default;
const os = (await import("node:os")).default;
const path = (await import("node:path")).default;
const { execFileSync } = await import("node:child_process");
const testDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "promo-workflow-real-"));
const previousDataDir = process.env.PROMO_DATA_DIR;
process.env.PROMO_DATA_DIR = testDataDir;

// 说明：网关 mock 必须回传可被 FFmpeg 真实归一化的媒体。用本机 ffmpeg 生成 1080x1920 黑帧 PNG 与 1s MP4，
// 以 b64_json / data URL 回给 mock，避免测试依赖外网 CDN。
const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "promo-real-fixtures-"));
const fixturePng = path.join(fixtureDir, "scene.png");
const fixtureMp4 = path.join(fixtureDir, "scene.mp4");
execFileSync("ffmpeg", ["-y", "-v", "error", "-f", "lavfi", "-i", "color=c=black:s=1080x1920", "-frames:v", "1", fixturePng], { windowsHide: true });
execFileSync("ffmpeg", ["-y", "-v", "error", "-f", "lavfi", "-i", "color=c=black:s=1080x1920:r=25:d=1", "-an", "-c:v", "libx264", "-pix_fmt", "yuv420p", fixtureMp4], { windowsHide: true });
const PNG_B64 = fs.readFileSync(fixturePng).toString("base64");
const MP4_B64 = fs.readFileSync(fixtureMp4).toString("base64");
// 记录真实 Provider 付费调用顺序，用于断言「音频通道先于素材通道」。
const providerCallOrder = [];

const { test, after } = await import("node:test");
const assert = (await import("node:assert/strict")).default;
after(() => {
  if (previousDataDir === undefined) delete process.env.PROMO_DATA_DIR;
  else process.env.PROMO_DATA_DIR = previousDataDir;
  fs.rmSync(testDataDir, { recursive: true, force: true });
  fs.rmSync(fixtureDir, { recursive: true, force: true });
});

function silentWav(durationSec = 0.25) {
  const sampleRate = 8_000;
  const samples = Math.round(sampleRate * durationSec);
  const dataBytes = samples * 2;
  const buffer = Buffer.alloc(44 + dataBytes);
  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(36 + dataBytes, 4);
  buffer.write("WAVEfmt ", 8);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36);
  buffer.writeUInt32LE(dataBytes, 40);
  return buffer;
}

const AUDIO_FIXTURE = silentWav();
const BROKEN_WAV = Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WAVE")]);
let scriptVoiceover = [
  { timecode: "00:00:00.000", text: "第一句" },
  { timecode: "00:00:00.000", text: "第二句" },
];
let workflowSpeechCall = 0;
let workflowFailSpeechAt = 0;
let workflowInvalidMusic = false;
let workflowStoryboardCount = 2;
let workflowStoryboardCall = 0;
let workflowFailStoryboardAt = 0;
let workflowImageCalls = 0;
let workflowVideoCalls = 0;

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
        title: "T", voiceover: scriptVoiceover, structure: ["a"], moodCurve: ["x"],
      }) } }], usage: { total_tokens: 120 } } });
    }
    workflowStoryboardCall += 1;
    if (workflowStoryboardCall === workflowFailStoryboardAt) {
      return makeRes({ ok: false, status: 500, text: "storyboard correction failed" });
    }
    return makeRes({ json: { choices: [{ message: { content: JSON.stringify({
      scenes: Array.from({ length: workflowStoryboardCount }, (_, index) => ({
        index: index + 1,
        visualPrompt: `p${index + 1}`,
        subtitle: `s${index + 1}`,
        camera: index % 2 ? "pull" : "push",
        durationSec: 5,
        musicClimax: index === workflowStoryboardCount - 1,
      })),
    }) } }], usage: { total_tokens: 200 } } });
  }
  if (path.endsWith("/images/generations")) {
    workflowImageCalls += 1;
    providerCallOrder.push("image");
    return makeRes({ json: { data: [{ b64_json: PNG_B64 }] } });
  }
  if (path.endsWith("/videos/generations") || path.endsWith("/video/generations")) {
    workflowVideoCalls += 1;
    providerCallOrder.push("video");
    return makeRes({ json: { data: [{ url: `data:video/mp4;base64,${MP4_B64}` }] } });
  }
  if (path.includes("/video") || path.includes("/videos")) workflowVideoCalls += 1;
  if (path.endsWith("/audio/speech")) {
    workflowSpeechCall += 1;
    providerCallOrder.push("tts");
    if (workflowSpeechCall === workflowFailSpeechAt) return makeRes({ ok: false, status: 500, text: "line failed" });
    return makeRes({ bytes: AUDIO_FIXTURE });
  }
  if (path.endsWith("/audio/music")) {
    providerCallOrder.push("music");
    const bytes = workflowInvalidMusic ? BROKEN_WAV : AUDIO_FIXTURE;
    return makeRes({ json: { data: [{ b64_json: bytes.toString("base64") }] } });
  }
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
const { applyVoiceTimelineToStoryboard } = await import("../src/mastra/workflow.js");
const { artifactPaths, MEDIA_LIMITS } = await import("../src/media/artifacts.js");
const { getRun } = await import("../src/store.js");
const { bus } = await import("../src/mastra/eventBus.js");
app.locals.generationPreflightDependencies = {
  verifyMediaToolchain: async () => {},
  artifactPaths: () => ({ outputRoot: process.cwd(), workspace: process.cwd() }),
  verifyWritable: async () => {},
};

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

test("真实模式缺少标准化片段或 FFmpeg：composite 硬失败且不降级交付", async () => {
  workflowSpeechCall = 0;
  const previousFfmpeg = process.env.PROMO_FFMPEG_BIN;
  delete process.env.PROMO_FFMPEG_BIN;
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
    // 真实模式不再静默降级为分镜包：成片合成失败必须让整个 run 失败并停在 composite。
    assert.equal(run.status, "failed", `应严格失败，实际=${run.status}`);
    assert.equal(run.steps.composite.status, "failed");
    assert.match(run.steps.composite.error, /标准化动态片段|PROMO_FFMPEG_BIN/);
    assert.equal(run.videoUrl ?? null, null, "失败运行不得返回成片地址");
    // 失败之前的上游真实调用（文本/图像/配音/配乐）仍应精确归集成本。
    assert.equal(run.cost.filter((entry) => entry.step === "voiceover").length, 1, "成功配音只归集一次");
    assert.equal(run.cost.filter((entry) => entry.step === "music").length, 1, "成功配乐只归集一次");
    const byStep = Object.fromEntries(run.cost.map((c) => [c.step, c.amount]));
    assert.ok(byStep.writeScript > 0, "writeScript 应计成本");
    assert.ok(byStep.generateScenes > 0, "generateScenes 应计成本（图像）");
    assert.ok(byStep.music > 0, "music 应计成本（曲目）");
    assert.equal(typeof byStep.composite, "undefined", "未通过校验的合成不得归集成本");
    // 硬失败不得留下任何“已交付”产物（无 final.mp4 / subtitles.srt / manifest.json / poster.jpg）。
    const paths = artifactPaths(runId);
    for (const key of ["finalVideo", "subtitles", "manifest", "poster"]) {
      assert.equal(fs.existsSync(paths[key]), false, `失败运行不应产出 ${key}`);
    }
    // 真实配音时间轴仍需写回分镜（0.25s 语音 + 非末镜 120ms 间隙）。
    assert.deepEqual(run.storyboard.map((scene) => scene.durationSec), [0.37, 0.25]);
  } finally {
    server.close();
    if (previousFfmpeg === undefined) delete process.env.PROMO_FFMPEG_BIN;
    else process.env.PROMO_FFMPEG_BIN = previousFfmpeg;
  }
});

test("voice timeline 严格校验旁白/分镜数量并传播权威场景时长", () => {
  const storyboard = [{ index: 1, durationSec: 9 }, { index: 2, durationSec: 9 }];
  const updated = applyVoiceTimelineToStoryboard(
    { voiceover: [{ text: "一" }, { text: "二" }] },
    storyboard,
    { sceneDurationsMs: [1520, 2100] },
  );
  assert.deepEqual(updated.map((scene) => scene.durationSec), [1.52, 2.1]);
  assert.throws(
    () => applyVoiceTimelineToStoryboard({ voiceover: [{ text: "一" }] }, storyboard, { sceneDurationsMs: [1000] }),
    /旁白.*分镜.*数量|数量.*不一致/,
  );
});

test("storyboard 两次数量不一致会在任何图像/视频调用前失败", async () => {
  workflowSpeechCall = 0;
  workflowImageCalls = 0;
  workflowVideoCalls = 0;
  workflowStoryboardCount = 1;
  const server = app.listen(0);
  const port = server.address().port;
  try {
    const response = await fetch(`${BASE(port)}/api/generate`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...baseBrief, hitlEnabled: false, finalGateEnabled: false }),
    });
    const { runId } = await response.json();
    const run = await waitStatus(port, runId, ["failed"]);
    assert.equal(run.steps.storyboard.status, "failed");
    assert.match(run.steps.storyboard.error, /分镜数量.*2|数量不一致/);
    assert.equal(workflowImageCalls, 0);
    assert.equal(workflowVideoCalls, 0);
    // 新顺序下 TTS 先于分镜：数量不一致必须在生成任何素材前失败，但配音已完成。
    assert.equal(workflowSpeechCall, 2);
  } finally {
    workflowStoryboardCount = 2;
    server.close();
  }
});

test("storyboard 首轮已付费且纠错请求失败时精确归集一次成本", async () => {
  workflowStoryboardCall = 0;
  workflowFailStoryboardAt = 2;
  workflowStoryboardCount = 1;
  workflowImageCalls = 0;
  const server = app.listen(0);
  const port = server.address().port;
  try {
    const response = await fetch(`${BASE(port)}/api/generate`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...baseBrief, hitlEnabled: false, finalGateEnabled: false }),
    });
    const { runId } = await response.json();
    const run = await waitStatus(port, runId, ["failed"]);
    const storyboardCosts = run.cost.filter((entry) => entry.step === "storyboard");
    assert.equal(storyboardCosts.length, 1);
    assert.ok(storyboardCosts[0].amount > 0);
    assert.equal(workflowImageCalls, 0);
  } finally {
    workflowFailStoryboardAt = 0;
    workflowStoryboardCount = 2;
    server.close();
  }
});

test("逐句 TTS 第 N 次失败仍归集已付 voiceover 成本", async () => {
  workflowSpeechCall = 0;
  workflowFailSpeechAt = 2;
  const server = app.listen(0);
  const port = server.address().port;
  try {
    const response = await fetch(`${BASE(port)}/api/generate`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...baseBrief, hitlEnabled: false, finalGateEnabled: false }),
    });
    const { runId } = await response.json();
    const run = await waitStatus(port, runId, ["failed"]);
    const voiceCosts = run.cost.filter((entry) => entry.step === "voiceover");
    assert.equal(voiceCosts.length, 1);
    assert.ok(voiceCosts[0].amount > 0);
    assert.equal(run.steps.voiceover.status, "failed");
  } finally {
    workflowFailSpeechAt = 0;
    server.close();
  }
});

test("配乐付费响应探测失败仍归集一次 music 成本", async () => {
  workflowSpeechCall = 0;
  workflowInvalidMusic = true;
  const server = app.listen(0);
  const port = server.address().port;
  try {
    const response = await fetch(`${BASE(port)}/api/generate`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...baseBrief, hitlEnabled: false, finalGateEnabled: false }),
    });
    const { runId } = await response.json();
    const run = await waitStatus(port, runId, ["failed"]);
    const musicCosts = run.cost.filter((entry) => entry.step === "music");
    assert.equal(musicCosts.length, 1);
    assert.equal(musicCosts[0].amount, 0.5);
    assert.equal(run.steps.music.status, "failed");
  } finally {
    workflowInvalidMusic = false;
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

test("REAL 严格顺序：TTS/配乐先于素材、每镜标准化动态片段、失败只发布一次且不进入交付", async () => {
  workflowSpeechCall = 0;
  workflowStoryboardCall = 0;
  workflowImageCalls = 0;
  workflowVideoCalls = 0;
  providerCallOrder.length = 0;
  const previousFfmpeg = process.env.PROMO_FFMPEG_BIN;
  delete process.env.PROMO_FFMPEG_BIN; // 让 composite 在步骤内硬失败，避免测试真跑一次完整合成
  const stepStarts = [];
  const compositeEvents = [];
  const failures = [];
  const finalReviews = [];
  const onProgress = (event) => {
    if (event.status === "step-start") stepStarts.push(event.step);
    if (event.step === "composite") compositeEvents.push(event);
  };
  const onFailed = (event) => failures.push(event);
  const onFinalReview = (event) => finalReviews.push(event);
  bus.on("progress", onProgress);
  bus.on("run-failed", onFailed);
  bus.on("final-review", onFinalReview);
  const server = app.listen(0);
  const port = server.address().port;
  try {
    const response = await fetch(`${BASE(port)}/api/generate`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...baseBrief, hitlEnabled: false, finalGateEnabled: true }),
    });
    const { runId } = await response.json();
    const run = await waitStatus(port, runId, ["failed"]);

    // 1) 严格步骤顺序：配音/配乐先于分镜与素材，合成收尾。
    const videoSteps = stepStarts.filter((step) => ["prepareVideo", "voiceover", "music", "storyboard", "generateScenes", "composite"].includes(step));
    assert.deepEqual(videoSteps, ["prepareVideo", "voiceover", "music", "storyboard", "generateScenes", "composite"]);

    // 2) 付费顺序：任何图像/视频调用之前必须完成 TTS 与配乐。
    const firstVisual = providerCallOrder.findIndex((kind) => kind === "image" || kind === "video");
    assert.ok(firstVisual > 0, `本轮应存在图像/视频调用，实际=${providerCallOrder.join(",")}`);
    for (const kind of ["tts", "music"]) {
      const index = providerCallOrder.indexOf(kind);
      assert.ok(index >= 0 && index < firstVisual, `${kind} 必须先于图像/视频：${providerCallOrder.join(",")}`);
    }

    // 3) 逐镜标准化动态片段与权威时长（videoPath 只存在于服务端 store，公开 API 会剥离）。
    const stored = getRun(runId);
    const voice = stored.steps.voiceover.output.voice;
    assert.equal(run.brief.videoModel, "minimax-h3", "未手选时应按优先级自动选 minimax-h3");
    assert.equal(stored.storyboard.length, scriptVoiceover.length);
    stored.storyboard.forEach((scene, index) => {
      assert.ok(typeof scene.videoPath === "string" && scene.videoPath !== "", `第 ${index + 1} 镜必须有标准化动态片段`);
      assert.ok(fs.existsSync(scene.videoPath), `第 ${index + 1} 镜动态片段应已落盘`);
      assert.equal(scene.durationSec, voice.sceneDurationsMs[index] / 1000);
    });
    // 每镜时长 = 实测语音时长，仅非末镜追加固定句间隔；总长必须等于权威音轨时长。
    const speechMs = scriptVoiceover.map((_, lineIndex) => {
      const cues = voice.cues.filter((cue) => cue.lineIndex === lineIndex);
      return cues[cues.length - 1].endMs - cues[0].startMs;
    });
    assert.deepEqual(
      voice.sceneDurationsMs,
      speechMs.map((ms, index) => ms + (index < speechMs.length - 1 ? MEDIA_LIMITS.voiceGapMs : 0)),
    );
    assert.equal(voice.sceneDurationsMs.reduce((sum, ms) => sum + ms, 0), Math.round(voice.durationSec * 1000));
    const sceneTotal = stored.storyboard.reduce((sum, scene) => sum + scene.durationSec, 0);
    assert.ok(Math.abs(sceneTotal * 1000 - voice.durationSec * 1000) < 1e-6, `分镜总时长 ${sceneTotal} 应等于权威音轨 ${voice.durationSec}`);

    // 4) 校验事件必须早于成片校验失败；失败运行只发一次 run-failed 且永不进入成片门。
    const validating = compositeEvents.find((event) => event.status === "step-progress" && event.phase === "validating" && event.message === "正在校验成片");
    assert.ok(validating, "composite 必须在校验产物前发出 validating 进度事件");
    const failedIndex = compositeEvents.findIndex((event) => event.status === "step-failed");
    assert.ok(failedIndex > compositeEvents.indexOf(validating), "validating 进度必须早于 composite 失败");
    assert.equal(run.status, "failed");
    assert.equal(run.steps.composite.status, "failed");
    assert.match(run.steps.composite.error, /PROMO_FFMPEG_BIN/);
    assert.equal(finalReviews.filter((event) => event.runId === runId).length, 0, "失败运行不得进入成片门");
    assert.equal(failures.filter((event) => event.runId === runId).length, 1, "同一 run 只发布一次 run-failed");
  } finally {
    bus.off("progress", onProgress);
    bus.off("run-failed", onFailed);
    bus.off("final-review", onFinalReview);
    server.close();
    if (previousFfmpeg === undefined) delete process.env.PROMO_FFMPEG_BIN;
    else process.env.PROMO_FFMPEG_BIN = previousFfmpeg;
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
