import { test } from "node:test";
import assert from "node:assert/strict";

process.env.STEP_DELAY_MS = "10"; // 加速测试，避免每步 400ms 真实停顿

const BASE = (port) => `http://127.0.0.1:${port}`;
const waitStatus = async (port, runId, statuses, timeoutMs = 15000) => {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const r = await fetch(`${BASE(port)}/api/runs/${runId}`);
    if (r.ok) {
      const run = await r.json();
      if (statuses.includes(run.status)) return run;
    }
    await new Promise((r) => setTimeout(r, 50));
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

test("非法 Brief 返回 400", async () => {
  const { app } = await import("../src/server.js");
  const server = app.listen(0);
  const port = server.address().port;
  try {
    const r = await fetch(`${BASE(port)}/api/generate`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({}),
    });
    assert.equal(r.status, 400);
  } finally {
    server.close();
  }
});

test("HITL 关闭：端到端产出分镜画廊 + SRT", async () => {
  const { app } = await import("../src/server.js");
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
    assert.equal(run.status, "success");
    assert.ok(Array.isArray(run.storyboardGallery) && run.storyboardGallery.length >= 3, "应产出分镜画廊");
    assert.ok(run.srt && run.srt.includes("-->"), "应产出 SRT");
    assert.equal(run.brief.language, "zh-CN");
  } finally {
    server.close();
  }
});

test("HITL 开启：脚本门 suspend → approve → success", async () => {
  const { app } = await import("../src/server.js");
  const server = app.listen(0);
  const port = server.address().port;
  try {
    const r = await fetch(`${BASE(port)}/api/generate`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...baseBrief, hitlEnabled: true, finalGateEnabled: false }),
    });
    const { runId } = await r.json();
    const suspended = await waitStatus(port, runId, ["suspended"]);
    assert.equal(suspended.status, "suspended");

    const approve = await fetch(`${BASE(port)}/api/generate/${runId}/approve`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ decision: "approve" }),
    });
    assert.equal(approve.status, 200);

    const done = await waitStatus(port, runId, ["success", "failed"]);
    assert.equal(done.status, "success");
    assert.ok(Array.isArray(done.storyboardGallery) && done.storyboardGallery.length >= 3);
  } finally {
    server.close();
  }
});

test("成片门（FR-9.2）：awaiting_delivery → approve → success", async () => {
  const { app } = await import("../src/server.js");
  const server = app.listen(0);
  const port = server.address().port;
  try {
    const r = await fetch(`${BASE(port)}/api/generate`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...baseBrief, hitlEnabled: false, finalGateEnabled: true }),
    });
    const { runId } = await r.json();
    const awaiting = await waitStatus(port, runId, ["awaiting_delivery"]);
    assert.equal(awaiting.status, "awaiting_delivery");
    assert.ok(awaiting.videoUrl !== undefined && awaiting.storyboardGallery.length >= 3, "成片预览应已就绪");

    const approve = await fetch(`${BASE(port)}/api/generate/${runId}/approve`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ decision: "approve" }),
    });
    assert.equal(approve.status, 200);

    const done = await waitStatus(port, runId, ["success", "failed"]);
    assert.equal(done.status, "success");
  } finally {
    server.close();
  }
});

test("成片门（FR-9.2）：reject 指定分镜 → 重新生成 → 再次 awaiting_delivery → approve", async () => {
  const { app } = await import("../src/server.js");
  const server = app.listen(0);
  const port = server.address().port;
  try {
    const r = await fetch(`${BASE(port)}/api/generate`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...baseBrief, hitlEnabled: false, finalGateEnabled: true }),
    });
    const { runId } = await r.json();
    await waitStatus(port, runId, ["awaiting_delivery"]);

    const reject = await fetch(`${BASE(port)}/api/generate/${runId}/approve`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ decision: "reject", scenes: [1] }),
    });
    assert.equal(reject.status, 200);

    const awaiting2 = await waitStatus(port, runId, ["awaiting_delivery"]);
    assert.equal(awaiting2.status, "awaiting_delivery");
    assert.equal(awaiting2.finalRejected, 1);

    await fetch(`${BASE(port)}/api/generate/${runId}/approve`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ decision: "approve" }),
    });
    const done = await waitStatus(port, runId, ["success", "failed"]);
    assert.equal(done.status, "success");
  } finally {
    server.close();
  }
});

test("GET /api/quota：返回账户累计与剩余配额", async () => {
  const { app } = await import("../src/server.js");
  const server = app.listen(0);
  const port = server.address().port;
  try {
    const r = await fetch(`${BASE(port)}/api/quota?account=acme`);
    assert.equal(r.status, 200);
    const q = await r.json();
    assert.equal(q.account, "acme");
    assert.equal(q.cap, 200);
    assert.ok(q.remaining <= q.cap);
  } finally {
    server.close();
  }
});

test("模板库端点（M4）：创建/列出/删除自定义模板", async () => {
  const { app } = await import("../src/server.js");
  const server = app.listen(0);
  const port = server.address().port;
  try {
    let r = await fetch(`${BASE(port)}/api/templates`);
    assert.equal(r.status, 200);
    assert.ok(Array.isArray(await r.json()));

    r = await fetch(`${BASE(port)}/api/templates`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "T1", defaultTone: "科技感", defaultLanguage: "en" }),
    });
    assert.equal(r.status, 201);
    const t = await r.json();
    assert.ok(t.id, "应分配 id");

    const list1 = await (await fetch(`${BASE(port)}/api/templates`)).json();
    assert.ok(list1.find((x) => x.id === t.id), "列表应包含新模板");

    r = await fetch(`${BASE(port)}/api/templates/${t.id}`, { method: "DELETE" });
    assert.equal(r.status, 200);
    const list2 = await (await fetch(`${BASE(port)}/api/templates`)).json();
    assert.ok(!list2.find((x) => x.id === t.id), "删除后不应在列表");
  } finally {
    server.close();
  }
});

test("模板库端点（M4）：非法模板名返回 400", async () => {
  const { app } = await import("../src/server.js");
  const server = app.listen(0);
  const port = server.address().port;
  try {
    const r = await fetch(`${BASE(port)}/api/templates`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({}),
    });
    assert.equal(r.status, 400);
  } finally {
    server.close();
  }
});

test("模板库端点（M4）：伪造 id / isPreset 被服务端拒绝（评审 F2/F3）", async () => {
  const { app } = await import("../src/server.js");
  const server = app.listen(0);
  const port = server.address().port;
  try {
    // 取当前首个预置（预置内容为铭星链产品线，id 可能演进——不硬编码具体 id）。
    const list0 = await (await fetch(`${BASE(port)}/api/templates`)).json();
    const preset0 = list0.find((x) => x.isPreset);
    assert.ok(preset0, "应存在预置模板");

    // 修复前：saveTemplate(req.body) 使 id/isPreset 完全客户端可控 ——
    // POST {id:preset0.id, isPreset:false} 即可覆盖预设并将其删除（预置永久丢失）。
    const r = await fetch(`${BASE(port)}/api/templates`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: preset0.id, name: "越权覆盖", isPreset: false }),
    });
    assert.equal(r.status, 201);
    const created = await r.json();
    assert.notEqual(created.id, preset0.id, "服务端应忽略客户端传入的 id");
    assert.equal(created.isPreset, false, "isPreset 应被强制为 false（防僵尸模板）");

    const list = await (await fetch(`${BASE(port)}/api/templates`)).json();
    const preset = list.find((x) => x.id === preset0.id);
    assert.ok(preset, "预置模板应仍然存在，未被覆盖或删除");
    assert.equal(preset.isPreset, true, "预置的 isPreset 不应被降格");

    const del = await fetch(`${BASE(port)}/api/templates/${preset0.id}`, { method: "DELETE" });
    assert.equal(del.status, 409, "预置模板不可删除");

    await fetch(`${BASE(port)}/api/templates/${created.id}`, { method: "DELETE" });
  } finally {
    server.close();
  }
});

test("模板库端点（M4）：PUT 部分更新保留其余字段（评审 F5）", async () => {
  const { app } = await import("../src/server.js");
  const server = app.listen(0);
  const port = server.address().port;
  try {
    const r0 = await fetch(`${BASE(port)}/api/templates`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "全量模板", logoColor: "#0ea5e9", industry: "科技", defaultLanguage: "en" }),
    });
    const t = await r0.json();

    // 修复前：saveTemplate({...req.body, id}) 为全量替换，只传 name 会静默清空其余字段。
    const r = await fetch(`${BASE(port)}/api/templates/${t.id}`, {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "只改名" }),
    });
    assert.equal(r.status, 200);
    const after = await r.json();
    assert.equal(after.name, "只改名");
    assert.equal(after.logoColor, "#0ea5e9", "未传字段应保留");
    assert.equal(after.industry, "科技", "未传字段应保留");
    assert.equal(after.defaultLanguage, "en", "未传字段不应退回默认值");

    await fetch(`${BASE(port)}/api/templates/${t.id}`, { method: "DELETE" });
  } finally {
    server.close();
  }
});

test("模板库端点（M4）：非法 logoColor 返回 400（评审 F6）", async () => {
  const { app } = await import("../src/server.js");
  const server = app.listen(0);
  const port = server.address().port;
  try {
    // 修复前仅校验 max(20)，任意字符串可进入 DEMO 的 SVG 填充属性并破坏图形渲染。
    const r = await fetch(`${BASE(port)}/api/templates`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "坏主色", logoColor: "red;background:url(x)" }),
    });
    assert.equal(r.status, 400);
    const j = await r.json();
    assert.match(j.error, /主色/);
  } finally {
    server.close();
  }
});

test("/api/config 暴露模型清单（能选模型、知道用的什么模型）", async () => {
  const { app } = await import("../src/server.js");
  const server = app.listen(0);
  const port = server.address().port;
  try {
    const cfg = await (await fetch(`${BASE(port)}/api/config`)).json();
    assert.ok(cfg.models, "config 应含 models 字段");
    assert.ok(Array.isArray(cfg.models.llm.choices) && cfg.models.llm.choices.length >= 2, "llm 应有可选清单");
    assert.ok(cfg.models.llm.choices.includes(cfg.models.llm.current), "current 应在清单内");
    assert.ok(Array.isArray(cfg.models.image.choices) && cfg.models.image.current, "image 应有清单与当前值");
    assert.ok(cfg.models.tts.current && cfg.models.music.current, "tts/music 应展示当前模型");
    assert.equal(typeof cfg.providerBaseUrl, "string", "应暴露供应商地址字段（运行时覆盖 > env，可为空串）");
    assert.equal(typeof cfg.apiKeySet, "boolean", "应暴露密钥是否配置（不回显密钥本身）");
  } finally {
    server.close();
  }
});

test("POST /api/config 保存供应商地址：非法 URL 400、合法保存并回显（运行时覆盖，免重启）", async () => {
  const { app } = await import("../src/server.js");
  const server = app.listen(0);
  const port = server.address().port;
  try {
    // 非法：非 http(s)
    let r = await fetch(`${BASE(port)}/api/config`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ providerBaseUrl: "ftp://nope" }),
    });
    assert.equal(r.status, 400);
    assert.match((await r.json()).error, /http/);

    // 合法：保存后 GET 立即回显（无需重启）
    const url = "https://one-api.test.local/v1";
    r = await fetch(`${BASE(port)}/api/config`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ providerBaseUrl: url }),
    });
    assert.equal(r.status, 200);
    const saved = await r.json();
    assert.equal(saved.providerBaseUrl, url);
    const cfg = await (await fetch(`${BASE(port)}/api/config`)).json();
    assert.equal(cfg.providerBaseUrl, url, "GET /api/config 应回显已保存的覆盖地址");

    // 空串 = 清除覆盖（回落 env），避免污染同进程后续测试
    r = await fetch(`${BASE(port)}/api/config`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ providerBaseUrl: "" }),
    });
    assert.equal(r.status, 200);
    const cleared = await (await fetch(`${BASE(port)}/api/config`)).json();
    assert.equal(cleared.providerBaseUrl, process.env.PROMO_ONEAPI_BASE_URL || "", "清空后应回落 env 默认");
  } finally {
    server.close();
  }
});

test("/api/copyideas 文案灵感：结合铭星链产品线预置，3 批轮换 + 未知模板回落通用", async () => {
  const { app } = await import("../src/server.js");
  const server = app.listen(0);
  const port = server.address().port;
  try {
    // 预置模板命中：卖点应含铭星链相关字样（本项目特点）
    const r0 = await (await fetch(`${BASE(port)}/api/copyideas?preset=preset-mingstar&batch=0`)).json();
    assert.equal(r0.preset, "preset-mingstar");
    assert.equal(r0.total, 3);
    assert.equal(r0.batch, 0);
    assert.ok(r0.sellingPoint.length <= 60, "卖点 ≤60 字");
    assert.ok(r0.keyMessages.length >= 3, "每批至少 3 条核心信息点");
    assert.match(r0.sellingPoint, /铭星链/, "主品牌文案应结合本项目特点");

    // batch 越界自动环绕
    const rw = await (await fetch(`${BASE(port)}/api/copyideas?preset=preset-mingstar&batch=3`)).json();
    assert.equal(rw.batch, 0, "batch 3 → 环绕回 0");
    const r2 = await (await fetch(`${BASE(port)}/api/copyideas?preset=preset-mingstar&batch=1`)).json();
    assert.notEqual(r2.sellingPoint, r0.sellingPoint, "不同批次的文案应不同");

    // 未知模板 → platform 通用场景（仍结合铭星链）
    const rp = await (await fetch(`${BASE(port)}/api/copyideas?preset=whatever&batch=1`)).json();
    assert.equal(rp.preset, "platform");
    assert.match(rp.scenario, /铭星链/);

    // 英文出海模板 → en 文案
    const ren = await (await fetch(`${BASE(port)}/api/copyideas?preset=preset-global-en&batch=0`)).json();
    assert.equal(ren.language, "en");
    assert.match(ren.sellingPoint, /MingStar/);
  } finally {
    server.close();
  }
});

test("/api/templates 预置已按铭星链产品线适配", async () => {
  const { app } = await import("../src/server.js");
  const server = app.listen(0);
  const port = server.address().port;
  try {
    const list = await (await fetch(`${BASE(port)}/api/templates`)).json();
    const presets = list.filter((t) => t.isPreset);
    assert.ok(presets.length >= 5, "至少 5 个预置");
    const names = presets.map((t) => t.name).join("|");
    assert.match(names, /铭星链/, "预置应含铭星链产品线模板");
    for (const t of presets) {
      assert.ok(t.brandName && t.productName && t.coreSellingPoint, `${t.name} 应带 brandName/productName/coreSellingPoint（套用即可产出）`);
      assert.ok(t.coreSellingPoint.length <= 60, `${t.name} 卖点 ≤60 字`);
    }
  } finally {
    server.close();
  }
});

test("GET /api/models：DEMO 返回占位清单；Brief.videoModel 可提交且 demo 不真调视频", async () => {
  const { app } = await import("../src/server.js");
  const server = app.listen(0);
  const port = server.address().port;
  try {
    const j = await (await fetch(`${BASE(port)}/api/models`)).json();
    assert.equal(j.source, "fallback", "DEMO 下不应声称连上了网关");
    assert.ok(Array.isArray(j.models.video) && j.models.video.length >= 1, "DEMO 视频给占位候选（声明路由演示）");
    assert.ok(j.models.llm.includes("deepseek-v4-flash"), "fallback llm 保留内置清单");

    // brief 带 videoModel：demo 下正常出片 success，且不产出真实视频片段（videoModel 仅 real 时生效）
    const r = await fetch(`${BASE(port)}/api/generate`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...baseBrief, videoModel: "kling-v1-6", hitlEnabled: false, finalGateEnabled: false }),
    });
    assert.equal(r.status, 200);
    const { runId } = await r.json();
    const run = await waitStatus(port, runId, ["success", "failed"]);
    assert.equal(run.status, "success");
    assert.equal(run.brief.videoModel, "kling-v1-6", "videoModel 应随 brief 回显");
    const anyVideo = (run.storyboard || []).some((s) => s.videoUrl);
    assert.equal(anyVideo, false, "demo 不应真调视频接口、不产出动态片段");
  } finally {
    server.close();
  }
});

test("GET /api/models：real + 本地 stub 网关 → source=gateway，type 优先 + 关键词兜底分类", async () => {
  const http = await import("node:http");
  const stub = http.createServer((req, res) => {
    if (req.url === "/models") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({
        data: [
          { id: "deepseek-v4-flash", type: "llm" },
          { id: "doubao-seedream-4-0-250828", type: "image" },
          { id: "kling-v1-6", type: "video" },
          { id: "doubao-seedance-1-0", type: "videogeneration" },
          { id: "tiny-iceberg", type: "tts" },
          { id: "plain-no-type" }, // 无 type → 兜底 llm
          { id: "hunyuan-video-pro" }, // 无 type → 关键词 video
          { id: "midjourney-v6" }, // 无 type → 关键词 image
        ],
      }));
    } else {
      res.statusCode = 404;
      res.end("nope");
    }
  });
  await new Promise((r) => stub.listen(0, r));
  const stubPort = stub.address().port;
  const { app } = await import("../src/server.js");
  const server = app.listen(0);
  const port = server.address().port;
  const { setRuntimeConfig } = await import("../src/runtime-config.js");
  const prevMode = process.env.PROMO_PROVIDER_MODE;
  const hadKey = Object.prototype.hasOwnProperty.call(process.env, "PROMO_ONEAPI_API_KEY");
  const prevKey = process.env.PROMO_ONEAPI_API_KEY;
  try {
    setRuntimeConfig({ providerBaseUrl: `http://127.0.0.1:${stubPort}` });
    process.env.PROMO_PROVIDER_MODE = "real";
    process.env.PROMO_ONEAPI_API_KEY = "sk-test";
    const j = await (await fetch(`${BASE(port)}/api/models?refresh=1`)).json();
    assert.equal(j.source, "gateway", "应成功从 stub 网关拉取");
    assert.ok(j.models.video.includes("kling-v1-6"), "type=video 归 video");
    assert.ok(j.models.video.includes("doubao-seedance-1-0"), "type=videogeneration 归 video");
    assert.ok(j.models.video.includes("hunyuan-video-pro"), "无 type 按关键词归 video");
    assert.ok(j.models.image.includes("doubao-seedream-4-0-250828") && j.models.image.includes("midjourney-v6"), "图像分类");
    assert.ok(j.models.audio.includes("tiny-iceberg"), "tts 归 audio");
    assert.ok(j.models.llm.includes("deepseek-v4-flash") && j.models.llm.includes("plain-no-type"), "llm 分类");
  } finally {
    if (prevMode === undefined) delete process.env.PROMO_PROVIDER_MODE;
    else process.env.PROMO_PROVIDER_MODE = prevMode;
    if (hadKey) process.env.PROMO_ONEAPI_API_KEY = prevKey;
    else delete process.env.PROMO_ONEAPI_API_KEY;
    setRuntimeConfig({ providerBaseUrl: "" });
    server.close();
    stub.close();
  }
});
