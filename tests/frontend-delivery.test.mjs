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

test("画面风格下拉提供六个受控预设，默认真人实拍且有中文标签", () => {
  const h = harness();
  assert.equal(h.run("DEFAULT_STYLE_PRESET"), "photoreal");
  const options = [...HTML.matchAll(/<option value="(photoreal|anime|three-d|illustration|ink-wash|custom)"([^>]*)>([^<]+)<\/option>/g)];
  assert.deepEqual(options.map((m) => m[1]), ["photoreal", "anime", "three-d", "illustration", "ink-wash", "custom"]);
  assert.match(options[0][2], /selected/, "默认真人实拍必须 selected");
  assert.deepEqual(options.map((m) => m[3]), ["真人实拍", "动漫", "3D 渲染", "插画", "国风水墨", "自定义"]);
  assert.equal(h.run('styleLabel("ink-wash")'), "国风水墨");
  assert.equal(h.run("styleLabel(undefined)"), "真人实拍");
  // 未知 id 直接回显，不得静默显示成默认画风，否则用户会以为风格已生效。
  assert.equal(h.run('styleLabel("cyberpunk")'), "cyberpunk");
});

test("风格描述输入仅在选择「自定义」时展开", () => {
  const h = harness();
  h.nodes.get("styleDescription").value = "黏土定格动画";
  h.nodes.get("stylePreset").value = "custom";
  h.run("syncStyleDescField()");
  assert.equal(h.nodes.get("styleDescField").classList.contains("hidden"), false, "custom 应展开描述输入");
  h.nodes.get("stylePreset").value = "photoreal";
  h.run("syncStyleDescField()");
  assert.equal(h.nodes.get("styleDescField").classList.contains("hidden"), true, "非 custom 应隐藏描述输入");
});

test("提交简报时带上画面风格预设，非自定义不带风格描述", async () => {
  const h = harness();
  let body = null;
  h.context.fetch = async (url, options) => {
    if (url === "/api/generate") body = JSON.parse(options.body);
    return { ok: true, status: 201, json: async () => ({ runId: "r1" }) };
  };
  h.nodes.get("stylePreset").value = "anime";
  await h.run("submitBrief()");
  assert.equal(body.stylePreset, "anime");
  assert.equal(body.styleDescription, undefined, "非自定义不该提交描述字段");
  h.nodes.get("stylePreset").value = "";
  await h.run("submitBrief()");
  assert.equal(body.stylePreset, "photoreal", "空值回落到默认风格");
});

test("选自定义但未填描述：前端直接拦下，不发起请求", async () => {
  const h = harness();
  let called = false;
  h.context.fetch = async () => {
    called = true;
    return { ok: true, status: 201, json: async () => ({ runId: "r1" }) };
  };
  h.nodes.get("stylePreset").value = "custom";
  h.nodes.get("styleDescription").value = "   ";
  await h.run("submitBrief()");
  assert.equal(called, false, "custom 缺描述必须在前端拦下，避免一次无效付费生成");
  assert.match(h.notices.at(-1)[0], /自定义/);
  h.nodes.get("styleDescription").value = "黏土定格动画";
  await h.run("submitBrief()");
  assert.equal(called, true, "补上描述后应正常提交");
});

test("交付页回显风格标签，manifest 记录优先于 Brief", () => {
  const h = harness({ stubDelivery: false });
  const baseRun = {
    runId: "r1", status: "success", videoUrl: "/api/video/r1",
    brief: { canvasPreset: "social-portrait", stylePreset: "anime", durationSec: 30, language: "zh-CN" },
    artifactManifest: { validated: true, canvas: { id: "social-portrait", width: 1080, height: 1920 } },
    storyboard: [], storyboardGallery: [],
  };
  h.run("renderDelivery(" + JSON.stringify(baseRun) + ")");
  assert.match(deliveryHtml(h), /风格：<b>动漫<\/b>/);
  h.run("renderDelivery(" + JSON.stringify({
    ...baseRun,
    artifactManifest: { ...baseRun.artifactManifest, style: { preset: "ink-wash", label: "国风水墨", description: "" } },
  }) + ")");
  assert.match(deliveryHtml(h), /风格：<b>国风水墨<\/b>/, "成交付清单记录应覆盖 Brief");
});

test("交付页回显自定义风格描述", () => {
  const h = harness({ stubDelivery: false });
  h.run("renderDelivery(" + JSON.stringify({
    runId: "r1", status: "success", videoUrl: "/api/video/r1",
    brief: { canvasPreset: "social-portrait", durationSec: 30, language: "zh-CN" },
    artifactManifest: { validated: true, style: { preset: "custom", label: "自定义", description: "黏土定格动画" } },
    storyboard: [], storyboardGallery: [],
  }) + ")");
  assert.match(deliveryHtml(h), /风格：<b>自定义（黏土定格动画）<\/b>/);
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
