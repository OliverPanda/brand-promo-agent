/**
 * @file 社交媒体成片交付前端用例。
 * @description 覆盖画布默认值、动态视频自动模型、MP4 交付渲染、成片校验子阶段与失败重跑。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { harness, HTML } from "./helpers/frontend-harness.mjs";

const deliveryHtml = (h) => h.nodes.get("delivery")?.html || "";
const META = (h, id) => h.nodes.get(`step-${id}`)?.querySelector(".meta").textContent || "";

test("默认画布为竖屏 1080×1920，三种社交媒体画布均有中文选项", () => {
  const h = harness();
  assert.equal(h.run("DEFAULT_CANVAS_PRESET"), "social-portrait");
  const options = [...HTML.matchAll(/<option value="(social-[a-z]+)"([^>]*)>([^<]+)<\/option>/g)];
  assert.deepEqual(options.map((m) => m[1]), ["social-portrait", "social-landscape", "social-square"]);
  assert.match(options[0][2], /selected/);
  const labels = options.map((m) => m[3]);
  assert.match(labels[0], /竖屏短视频 1080×1920（9:16）/);
  assert.match(labels[1], /横屏短视频 1920×1080（16:9）/);
  assert.match(labels[2], /方形短视频 1080×1080（1:1）/);
});

test("提交简报时带上画布，空值回落到默认竖屏且不伪造手选视频模型", async () => {
  const h = harness();
  let body = null;
  h.context.fetch = async (url, options) => {
    if (url === "/api/generate") body = JSON.parse(options.body);
    return { ok: true, status: 201, json: async () => ({ runId: "r1" }) };
  };
  await h.run("submitBrief()");
  assert.equal(body.canvasPreset, "social-portrait");
  assert.equal(body.videoModel, undefined);
});

test("动态视频默认显示自动解析结果，不再显示「不启用」", () => {
  const h = harness();
  assert.equal(h.run('pickDefaultVideoModel({ current: "" }, ["veo-3", "seedance-2.0", "minimax-h3"])'), "minimax-h3");
  assert.equal(h.run('pickDefaultVideoModel({ current: "" }, ["7zhe-seedance", "seedance-2.0"])'), "7zhe-seedance");
  assert.equal(h.run('pickDefaultVideoModel({ current: "" }, ["seedance_2_0", "seedance-2.0-fast"])'), "seedance_2_0");
  assert.equal(h.run('pickDefaultVideoModel({ current: "veo-3" }, [])'), "veo-3");
  h.run('fillVideoModelSelect({ current: "" }, ["veo-3", "seedance-2.0", "minimax-h3"])');
  const options = h.nodes.get("videoModel").children;
  assert.equal(options[0].value, "");
  assert.match(options[0].textContent, /^自动（当前：minimax-h3）$/);
  assert.deepEqual(options.slice(1).map((o) => o.value), ["veo-3", "seedance-2.0"]);
  assert.ok(!options.some((o) => /不启用/.test(o.textContent)));
});

test("已校验成片渲染 MP4 播放器与三类下载，并回显画布、模型与来源", () => {
  const h = harness({ stubDelivery: false });
  const run = {
    runId: "r1", status: "success", videoUrl: "/api/video/r1", poster: "/api/runs/r1/scenes/1/image",
    srt: "1\n00:00:00,000 --> 00:00:02,000\n你好\n",
    brief: { canvasPreset: "social-square", durationSec: 30, language: "zh-CN", videoModel: "minimax-h3", modelSelectionSource: "automatic" },
    artifactManifest: {
      validated: true,
      canvas: { id: "social-square", width: 1080, height: 1080, aspectRatio: "1:1" },
      models: { video: "minimax-h3", tts: "speech-02-hd", music: "mureka-song" },
      scenes: [{ index: 1, durationSec: 6 }],
      timeline: { durationSec: 30 },
    },
    storyboard: [], storyboardGallery: [],
    note: "已合成为 MP4（服务端 FFmpeg，含配音、配乐与中文硬字幕）。",
  };
  h.run(`renderDelivery(${JSON.stringify(run)})`);
  const html = deliveryHtml(h);
  assert.match(html, /<video class="final-video" src="\/api\/video\/r1" controls preload="metadata"/);
  assert.match(html, /href="\/api\/runs\/r1\/artifacts\/video" download/);
  assert.match(html, /href="\/api\/runs\/r1\/artifacts\/subtitles" download/);
  assert.match(html, /href="\/api\/runs\/r1\/artifacts\/poster" download/);
  assert.ok(!/data:text\/plain/.test(html), "字幕必须走受控下载路由，不能用 data URL");
  assert.match(html, /方形短视频 1080×1080（1:1）/);
  assert.match(html, /动态视频 minimax-h3（自动优先级）/);
  assert.match(html, /配音 speech-02-hd/);
  assert.match(html, /配乐 mureka-song/);
  assert.match(html, /已通过（可交付）/);
});

test("校验通过的成片走 run-done 时提示 MP4 交付，DEMO 结果不得冒充成片", () => {
  const h = harness();
  const real = { runId: "r1", status: "success", videoUrl: "/api/video/r1", artifactManifest: { validated: true } };
  h.run(`onDone(${JSON.stringify(real)})`);
  assert.match(h.notices[0][0], /成片 MP4 已交付/);
  const demo = { runId: "r2", status: "success", videoUrl: null, note: "DEMO/降级模式：未接入真实合成服务。" };
  const before = h.notices.length;
  h.run(`onDone(${JSON.stringify(demo)})`);
  const fresh = h.notices.slice(before);
  assert.ok(!fresh.some((n) => /成片 MP4 已交付/.test(String(n[0] || ""))), "DEMO 结果不得宣称 MP4 交付");
  assert.match(fresh.at(-1)[0], /未产出 MP4 成片/);
});

test("composite 进度回显「正在校验成片」，成片门到达后清除", () => {
  const h = harness({ stubDelivery: false });
  h.run('openStream("r1")');
  h.sources[0].send("progress", { runId: "r1", step: "composite", status: "step-progress", phase: "compositing", message: "正在合成成片" });
  assert.equal(META(h, "composite"), "正在合成成片");
  h.sources[0].send("progress", { runId: "r1", step: "composite", status: "step-progress", phase: "validating", message: "正在校验成片" });
  assert.equal(META(h, "composite"), "正在校验成片");
  h.sources[0].send("final-review", { runId: "r1", preview: { videoUrl: "/api/video/r1", gallery: [] } });
  assert.equal(META(h, "composite"), "");
  assert.match(h.nodes.get("finalPreview").html, /<video class="final-video" src="\/api\/video\/r1"/);
  assert.ok(!h.nodes.get("finalGateModal").classList.contains("hidden"));
});

test("失败快照关闭审核门、显示失败环节与原因，并提供重跑按钮", () => {
  const h = harness();
  h.run('openStream("r1")');
  h.sources[0].send("snapshot", { run: { runId: "r1", status: "failed", error: "分镜超时", steps: { storyboard: { status: "failed", error: "分镜超时" } } } });
  assert.ok(h.sources[0].closed, "失败终态必须关闭 SSE，避免一直重连");
  assert.match(h.notices[0][0], /分镜拆解/);
  assert.match(h.notices[0][0], /分镜超时/);
  const html = deliveryHtml(h);
  assert.match(html, /失败环节：<b>分镜拆解<\/b>/);
  assert.match(html, /失败原因：<b>分镜超时<\/b>/);
  assert.match(html, /id="rerunBtn"/);
  assert.ok(!h.nodes.get("resultCard").classList.contains("hidden"), "失败详情必须可见");
});

test("重跑成功后切换到新 runId 并新开 SSE 流", async () => {
  const h = harness();
  h.run('openStream("r1")');
  h.sources[0].send("snapshot", { run: { runId: "r1", status: "failed", error: "配音失败", steps: { voiceover: { status: "failed", error: "配音失败" } } } });
  h.context.fetch = async (url, options) => {
    assert.equal(url, "/api/runs/r1/rerun");
    assert.equal(options.method, "POST");
    return { ok: true, status: 201, json: async () => ({ runId: "r2" }) };
  };
  await h.run("rerunFailed()");
  assert.equal(h.run("currentRunId"), "r2");
  const stream = h.sources.at(-1);
  assert.equal(stream.url, "/api/generate/r2/stream");
  assert.ok(!stream.closed);
  assert.equal(h.nodes.get("steps").children.length, 0, "切换任务必须清空旧步骤");
});

test("历史降级运行标注为历史产物且不宣称 MP4 交付", () => {
  const h = harness({ stubDelivery: false });
  h.run(`renderDelivery(${JSON.stringify({ runId: "old", status: "success", storyboardGallery: [{ index: 1, mediaUrl: "/api/runs/old/scenes/1/image" }] })})`);
  const html = deliveryHtml(h);
  assert.match(html, /历史降级产物/);
  assert.ok(!/成片 MP4/.test(html), "历史 run 不得出现成片 MP4 字样");
  assert.ok(!/artifacts\/video/.test(html), "历史 run 不得渲染 MP4 下载路由");
});

test("DEMO 运行标注为演示结果且不宣称 MP4 交付", () => {
  const h = harness({ stubDelivery: false });
  h.run(`renderDelivery(${JSON.stringify({ runId: "demo", status: "success", poster: "/poster.jpg", note: "DEMO/降级模式：未接入真实合成服务，以下为分镜故事板。" })})`);
  const html = deliveryHtml(h);
  assert.match(html, /演示结果/);
  assert.ok(!/成片 MP4/.test(html), "DEMO 结果不得出现成片 MP4 字样");
  assert.match(html, /不适用（无 MP4 产物）/);
});
