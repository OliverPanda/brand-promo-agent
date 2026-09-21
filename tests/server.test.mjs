import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

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

test("场景资产只通过受控 URL 暴露，图片 MIME 正确、视频支持 Range 且不泄漏本地路径", async () => {
  const previousOutputRoot = process.env.PROMO_OUTPUT_ROOT;
  const outputRoot = fs.mkdtempSync(path.join(os.tmpdir(), "promo-scene-routes-"));
  process.env.PROMO_OUTPUT_ROOT = outputRoot;
  const { artifactPaths } = await import("../src/media/artifacts.js");
  const { createRun, updateRun } = await import("../src/store.js");
  const { app } = await import("../src/server.js");
  const runId = `scene-route-${Date.now()}`;
  const paths = artifactPaths(runId);
  const mediaPath = path.join(paths.scenes, "scene-image.png");
  const videoPath = path.join(paths.scenes, "scene-video.mp4");
  execFileSync("ffmpeg", ["-y", "-f", "lavfi", "-i", "color=c=orange:s=1080x1920", "-frames:v", "1", mediaPath], { stdio: "pipe" });
  execFileSync("ffmpeg", ["-y", "-f", "lavfi", "-i", "color=c=blue:s=1080x1920:r=25:d=1", "-an", "-c:v", "libx264", "-pix_fmt", "yuv420p", videoPath], { stdio: "pipe" });
  createRun(runId, baseBrief);
  updateRun(runId, { storyboard: [{ index: 1, mediaPath, videoPath, mediaUrl: `file://${mediaPath}`, videoUrl: `file://${videoPath}` }] });

  const server = app.listen(0);
  const port = server.address().port;
  try {
    const runResponse = await fetch(`${BASE(port)}/api/runs/${runId}`);
    assert.equal(runResponse.status, 200);
    const publicRun = await runResponse.json();
    const serialized = JSON.stringify(publicRun);
    assert.equal(serialized.includes(outputRoot), false);
    assert.equal(serialized.includes("file://"), false);
    assert.equal(publicRun.storyboard[0].mediaPath, undefined);
    assert.equal(publicRun.storyboard[0].videoPath, undefined);
    assert.equal(publicRun.storyboard[0].mediaUrl, `/api/runs/${runId}/scenes/1/image`);
    assert.equal(publicRun.storyboard[0].videoUrl, `/api/runs/${runId}/scenes/1/video`);

    // 真实模式 composite() 会把场景图（file://）写进 storyboardGallery，公开视图必须改写为受控路由。
    updateRun(runId, { storyboardGallery: [
      { index: 1, mediaUrl: `file://${mediaPath}`, subtitle: "第一句" },
      { index: 9, mediaUrl: `file://${mediaPath}`, subtitle: "越界镜号" },
    ] });
    const galleryRun = await (await fetch(`${BASE(port)}/api/runs/${runId}`)).json();
    assert.equal(JSON.stringify(galleryRun).includes("file://"), false);
    assert.equal(galleryRun.storyboardGallery[0].mediaUrl, `/api/runs/${runId}/scenes/1/image`);
    assert.equal(galleryRun.storyboardGallery[1].mediaUrl, null, "镜号越界不能回落到受控路由");
    assert.equal(galleryRun.storyboardGallery[0].subtitle, "第一句");

    const imageResponse = await fetch(`${BASE(port)}${publicRun.storyboard[0].mediaUrl}`);
    assert.equal(imageResponse.status, 200);
    assert.equal(imageResponse.headers.get("content-type"), "image/png");
    assert.ok((await imageResponse.arrayBuffer()).byteLength > 100);

    const videoResponse = await fetch(`${BASE(port)}${publicRun.storyboard[0].videoUrl}`, { headers: { Range: "bytes=0-99" } });
    assert.equal(videoResponse.status, 206);
    assert.equal(videoResponse.headers.get("content-type"), "video/mp4");
    assert.match(videoResponse.headers.get("content-range") || "", /^bytes 0-99\//u);

    updateRun(runId, { storyboard: [{ index: 1, mediaPath: path.join(outputRoot, "outside.png") }] });
    fs.copyFileSync(mediaPath, path.join(outputRoot, "outside.png"));
    const escaped = await fetch(`${BASE(port)}/api/runs/${runId}/scenes/1/image`);
    assert.equal(escaped.status, 404);
  } finally {
    server.close();
    if (previousOutputRoot === undefined) delete process.env.PROMO_OUTPUT_ROOT;
    else process.env.PROMO_OUTPUT_ROOT = previousOutputRoot;
    fs.rmSync(outputRoot, { recursive: true, force: true });
  }
});

test("prepareGenerationBrief：REAL 成功预检写回画布与模型审计字段", async () => {
  const { prepareGenerationBrief } = await import("../src/mastra/workflow.js");
  const calls = [];
  const brief = await prepareGenerationBrief(baseBrief, {
    runId: "preflight-unit-1",
    dependencies: {
      verifyMediaToolchain: async () => calls.push("toolchain"),
      fetchRemoteModels: async () => ({
        byType: { video: ["7zhe-seedance", "minimax-h3"], audio: ["speech-02-hd", "mureka-v1"] },
        raw: [
          { id: "minimax-h3", type: "video" },
          { id: "7zhe-seedance", type: "video" },
          { id: "speech-02-hd", type: "tts" },
          { id: "mureka-v1", type: "music" },
        ],
      }),
      artifactPaths: () => ({ outputRoot: process.cwd(), workspace: process.cwd() }),
      verifyWritable: async () => calls.push("writable"),
      providerMode: () => "real",
      providerBase: () => "https://gateway.example/v1",
      providerKey: () => "secret-not-returned",
      musicPath: () => "/audio/music",
      musicModel: () => "mureka-v1",
      ttsModel: () => "",
    },
  });
  assert.equal(brief.canvasPreset, "social-portrait");
  assert.equal(brief.videoModel, "minimax-h3");
  assert.equal(brief.ttsModel, "speech-02-hd");
  assert.equal(brief.musicModel, "mureka-v1");
  assert.equal(brief.modelSelectionSource, "automatic");
  assert.deepEqual(calls, ["toolchain", "writable"]);
});

test("prepareGenerationBrief：Brief 未选时采用并校验 PROMO_VIDEO_MODEL", async () => {
  const { prepareGenerationBrief } = await import("../src/mastra/workflow.js");
  const previous = process.env.PROMO_VIDEO_MODEL;
  process.env.PROMO_VIDEO_MODEL = "seedance-2.0";
  try {
    const brief = await prepareGenerationBrief(baseBrief, {
      runId: "preflight-env-video",
      dependencies: {
        verifyMediaToolchain: async () => {},
        fetchRemoteModels: async () => ({
          byType: { video: ["minimax-h3", "seedance-2.0"], audio: ["speech-02-hd"] },
          raw: [{ id: "speech-02-hd", type: "tts" }],
        }),
        artifactPaths: () => ({ outputRoot: process.cwd(), workspace: process.cwd() }),
        verifyWritable: async () => {},
        providerMode: () => "real",
        providerBase: () => "https://gateway.example/v1",
        providerKey: () => "secret-not-returned",
        musicPath: () => "/audio/music",
        musicModel: () => "mureka-v1",
        ttsModel: () => "speech-02-hd",
      },
    });
    assert.equal(brief.videoModel, "seedance-2.0");
    assert.equal(brief.modelSelectionSource, "configured");
  } finally {
    if (previous === undefined) delete process.env.PROMO_VIDEO_MODEL;
    else process.env.PROMO_VIDEO_MODEL = previous;
  }
});

test("prepareGenerationBrief：REAL 手选非实时视频模型标记为 400", async () => {
  const { prepareGenerationBrief } = await import("../src/mastra/workflow.js");
  await assert.rejects(
    prepareGenerationBrief({ ...baseBrief, videoModel: "fake-video" }, {
      runId: "preflight-unit-2",
      dependencies: {
        verifyMediaToolchain: async () => {},
        fetchRemoteModels: async () => ({
          byType: { video: ["minimax-h3"], audio: ["speech-02-hd"] },
          raw: [{ id: "minimax-h3", type: "video" }, { id: "speech-02-hd", type: "tts" }],
        }),
        artifactPaths: () => ({ outputRoot: process.cwd(), workspace: process.cwd() }),
        verifyWritable: async () => {},
        providerMode: () => "real",
        providerBase: () => "https://gateway.example/v1",
        providerKey: () => "secret-not-returned",
        musicPath: () => "/audio/music",
        musicModel: () => "mureka-v1",
        ttsModel: () => "",
      },
    }),
    (error) => error.statusCode === 400 && /所选动态视频模型不可用/.test(error.message)
  );
});

test("prepareGenerationBrief：PROMO_TTS_MODEL 指向音乐模型时预检失败", async () => {
  const { prepareGenerationBrief } = await import("../src/mastra/workflow.js");
  await assert.rejects(
    prepareGenerationBrief(baseBrief, {
      runId: "preflight-tts-music",
      dependencies: {
        verifyMediaToolchain: async () => {},
        fetchRemoteModels: async () => ({
          byType: { video: ["minimax-h3"], audio: ["speech-02-hd", "mureka-v1"] },
          raw: [{ id: "speech-02-hd", type: "tts" }, { id: "mureka-v1", type: "music" }],
        }),
        providerMode: () => "real",
        providerBase: () => "https://gateway.example/v1",
        providerKey: () => "secret-not-returned",
        musicPath: () => "/audio/music",
        musicModel: () => "mureka-v1",
        ttsModel: () => "mureka-v1",
      },
    }),
    (error) => error.statusCode === 503 && /TTS 模型不可用/.test(error.message)
  );
});

test("prepareGenerationBrief：文件系统异常不向 503 暴露路径或底层文本", async (t) => {
  const { prepareGenerationBrief } = await import("../src/mastra/workflow.js");
  t.mock.method(console, "error", () => {});
  await assert.rejects(
    prepareGenerationBrief(baseBrief, {
      runId: "preflight-fs-error",
      dependencies: {
        verifyMediaToolchain: async () => {},
        fetchRemoteModels: async () => ({
          byType: { video: ["minimax-h3"], audio: ["speech-02-hd"] },
          raw: [{ id: "speech-02-hd", type: "tts" }],
        }),
        artifactPaths: () => { throw new Error("EACCES: C:\\secret\\customer\\outputs"); },
        providerMode: () => "real",
        providerBase: () => "https://gateway.example/v1",
        providerKey: () => "secret-not-returned",
        musicPath: () => "/audio/music",
        musicModel: () => "mureka-v1",
        ttsModel: () => "speech-02-hd",
      },
    }),
    (error) => error.statusCode === 503
      && error.message === "真实生成预检失败：输出目录不可创建或写入"
      && !error.message.includes("secret")
      && !error.message.includes("EACCES")
  );
});

test("POST /api/generate：REAL 环境预检失败返回 503 且不创建 run", async () => {
  const { app } = await import("../src/server.js");
  const { setRuntimeConfig } = await import("../src/runtime-config.js");
  const server = app.listen(0);
  const port = server.address().port;
  const before = (await (await fetch(`${BASE(port)}/api/runs`)).json()).length;
  const previous = {
    mode: process.env.PROMO_PROVIDER_MODE,
    base: process.env.PROMO_ONEAPI_BASE_URL,
    key: process.env.PROMO_ONEAPI_API_KEY,
  };
  try {
    process.env.PROMO_PROVIDER_MODE = "real";
    delete process.env.PROMO_ONEAPI_BASE_URL;
    delete process.env.PROMO_ONEAPI_API_KEY;
    setRuntimeConfig({ providerMode: "", providerBaseUrl: "", apiKey: "" });
    const response = await fetch(`${BASE(port)}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(baseBrief),
    });
    assert.equal(response.status, 503);
    assert.match((await response.json()).error, /预检|供应商地址/);
    const after = (await (await fetch(`${BASE(port)}/api/runs`)).json()).length;
    assert.equal(after, before, "预检失败不得留下 run");
  } finally {
    process.env.PROMO_PROVIDER_MODE = previous.mode || "demo";
    if (previous.base === undefined) delete process.env.PROMO_ONEAPI_BASE_URL;
    else process.env.PROMO_ONEAPI_BASE_URL = previous.base;
    if (previous.key === undefined) delete process.env.PROMO_ONEAPI_API_KEY;
    else process.env.PROMO_ONEAPI_API_KEY = previous.key;
    setRuntimeConfig({ providerMode: "", providerBaseUrl: "", apiKey: "" });
    server.close();
  }
});

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
    assert.equal(run.storyboard.reduce((sum, scene) => sum + scene.durationSec, 0), 30, "DEMO 权威分镜总时长保持 30 秒");
    assert.match(run.srt, /00:00:24,000 --> 00:00:30,000/);
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

    // 说明：审批前主动断开 SSE，模拟刷新；订阅清理不能删除审批恢复闭包。
    const controller = new AbortController();
    const stream = await fetch(`${BASE(port)}/api/generate/${runId}/stream`, { signal: controller.signal });
    const reader = stream.body.getReader();
    await reader.read();
    controller.abort();
    await reader.cancel().catch(() => {});
    await new Promise(resolve => setTimeout(resolve, 30));

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

test("GET /api/quota：账户为部署级固定值（不echo客户端 account，防换名绕过配额）", async () => {
  const { app } = await import("../src/server.js");
  const server = app.listen(0);
  const port = server.address().port;
  try {
    const r = await fetch(`${BASE(port)}/api/quota?account=acme`);
    assert.equal(r.status, 200);
    const q = await r.json();
    assert.equal(q.account, process.env.PROMO_ACCOUNT || "local");
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

test("POST /api/config 保存运行模式 + API Key：real 即时生效、密钥可写不可读、非法值 400", async () => {
  const { app } = await import("../src/server.js");
  const server = app.listen(0);
  const port = server.address().port;
  const { getProviderMode } = await import("../src/mastra/providers.js");
  const { setRuntimeConfig } = await import("../src/runtime-config.js");
  const prevMode = process.env.PROMO_PROVIDER_MODE;
  const envKey = process.env.PROMO_ONEAPI_API_KEY || process.env.OPENAI_API_KEY || "";
  try {
    // 隔离：确保本次验证走「运行时配置」开关，而不是 env 的 real
    delete process.env.PROMO_PROVIDER_MODE;

    // 非法值：mode 非 demo|real → 400；key 超长 → 400
    let r = await fetch(`${BASE(port)}/api/config`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ providerMode: "turbo" }),
    });
    assert.equal(r.status, 400);
    r = await fetch(`${BASE(port)}/api/config`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ apiKey: "x".repeat(201) }),
    });
    assert.equal(r.status, 400);

    // 保存 real + API Key + 地址（页面「模型与服务」一次提交三项）
    r = await fetch(`${BASE(port)}/api/config`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ providerMode: "real", apiKey: "sk-page-123", providerBaseUrl: "https://one-api.page/v1" }),
    });
    assert.equal(r.status, 200);
    const saved = await r.json();
    assert.equal(saved.mode, "real");
    assert.equal(saved.apiKeySet, true);

    // provider 层免重启生效（这正是「页面配完即可真跑」的核心）
    assert.equal(getProviderMode(), "real", "保存 real 后 getProviderMode 应立即返回 real");

    // GET 回显：mode/地址/是否配置齐全，但绝不含密钥明文
    const cfg = await (await fetch(`${BASE(port)}/api/config`)).json();
    assert.equal(cfg.mode, "real");
    assert.equal(cfg.apiKeySet, true);
    assert.equal(cfg.providerBaseUrl, "https://one-api.page/v1");
    assert.ok(!JSON.stringify(cfg).includes("sk-page-123"), "GET 绝不回显密钥明文（可写不可读）");

    // 空串清除 mode + key → 回落 env/demo
    r = await fetch(`${BASE(port)}/api/config`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ providerMode: "", apiKey: "" }),
    });
    assert.equal(r.status, 200);
    const cleared = await (await fetch(`${BASE(port)}/api/config`)).json();
    assert.equal(cleared.mode, ["real", "demo"].includes(process.env.PROMO_PROVIDER_MODE) ? process.env.PROMO_PROVIDER_MODE : "real", "清空后回落显式 env 或默认 real");
    assert.equal(cleared.apiKeySet, !!envKey, "清空后密钥状态回落 env");
    assert.equal(getProviderMode(), cleared.mode);
  } finally {
    // 还原 env 与 runtime，避免污染同进程后续用例
    if (prevMode === undefined) delete process.env.PROMO_PROVIDER_MODE;
    else process.env.PROMO_PROVIDER_MODE = prevMode;
    setRuntimeConfig({ providerMode: "", apiKey: "", providerBaseUrl: "" });
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
