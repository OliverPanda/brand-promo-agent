// generateSceneVideo 真实调用骨架测试：用本地 stub 网关覆盖全部路径——
//   同步返回 / 异步轮询成功 / GET 404 → 备选端点 / 任务失败 / 轮询超时 / 未指定模型 / DEMO stub。
// 说明：真实渠道若字段有出入，以目标网关为准；此测试锁定「OpenAI 兼容骨架」行为，防止回归。
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { deliverySeed, generateSceneVideo } from "../src/mastra/providers.js";
import { artifactPaths } from "../src/media/artifacts.js";
import { setRuntimeConfig, getEffectiveOneApiBase } from "../src/runtime-config.js";

function listen(handler) {
  return new Promise((resolve) => {
    const srv = http.createServer(handler);
    srv.listen(0, () => resolve(srv));
  });
}
const portOf = (srv) => srv.address().port;

// 收集请求体
function readBody(req) {
  return new Promise((resolve) => {
    let d = "";
    req.on("data", (c) => (d += c));
    req.on("end", () => resolve(d ? JSON.parse(d) : {}));
  });
}

const scene = { index: 1, visualPrompt: "产品特写，科技感", mediaUrl: "https://cdn.example.com/s1.png" };
const brief = { videoModel: "", logoColor: "#6366f1" };

const prevMode = process.env.PROMO_PROVIDER_MODE;
const hadKey = Object.prototype.hasOwnProperty.call(process.env, "PROMO_ONEAPI_API_KEY");
const prevKey = process.env.PROMO_ONEAPI_API_KEY;
const prevBase = getEffectiveOneApiBase();
const prevTimeout = process.env.PROMO_VIDEO_TIMEOUT_MS;
const prevPoll = process.env.PROMO_VIDEO_POLL_MS;

async function withReal(stub, fn) {
  setRuntimeConfig({ providerBaseUrl: `http://127.0.0.1:${portOf(stub)}` });
  process.env.PROMO_PROVIDER_MODE = "real";
  process.env.PROMO_ONEAPI_API_KEY = "sk-test";
  try {
    return await fn();
  } finally {
    setRuntimeConfig({ providerBaseUrl: prevBase || "" });
    if (prevMode === undefined) delete process.env.PROMO_PROVIDER_MODE;
    else process.env.PROMO_PROVIDER_MODE = prevMode;
    if (hadKey) process.env.PROMO_ONEAPI_API_KEY = prevKey;
    else delete process.env.PROMO_ONEAPI_API_KEY;
    if (prevTimeout === undefined) delete process.env.PROMO_VIDEO_TIMEOUT_MS;
    else process.env.PROMO_VIDEO_TIMEOUT_MS = prevTimeout;
    if (prevPoll === undefined) delete process.env.PROMO_VIDEO_POLL_MS;
    else process.env.PROMO_VIDEO_POLL_MS = prevPoll;
  }
}

test("generateSceneVideo：同步返回 {data:[{url}]}（图生视频 image 已带）", async () => {
  let gotBody = null;
  const stub = await listen(async (req, res) => {
    if (req.method === "POST" && req.url === "/videos/generations") {
      gotBody = await readBody(req);
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ data: [{ url: "https://cdn.example.com/out1.mp4" }] }));
    } else {
      res.statusCode = 404; res.end();
    }
  });
  try {
    const out = await withReal(stub, () =>
      generateSceneVideo(scene, { ...brief, videoModel: "kling-v1-6" }));
    assert.equal(out.kind, "video");
    assert.equal(out.videoUrl, "https://cdn.example.com/out1.mp4");
    assert.equal(out.model, "kling-v1-6");
    assert.deepEqual(out._usage, { videos: 1 });
    assert.equal(gotBody.model, "kling-v1-6");
    assert.equal(gotBody.image, "https://cdn.example.com/s1.png", "应带场景图 URL 走图生视频");
    assert.equal(gotBody.aspect_ratio, "9:16");
    assert.equal(gotBody.width, 1080);
    assert.equal(gotBody.height, 1920);
    assert.equal(gotBody.size, "1080x1920");
    assert.match(gotBody.prompt, /#6366f1/, "logoColor 应注入 prompt");
    // 全片画风漂移回归（PRD §16.13）：视频提交体必须与分镜、场景图同源携带风格锚点。
    assert.match(gotBody.prompt, /全片统一风格锚点/, "视频提交 prompt 必须携带风格锚点");
    assert.match(gotBody.prompt, /不得逐镜切换画风/);
    // 固定 seed 只认 metadata：网关 TaskSubmitReq 的顶层 seed 会被直接丢弃（设计文档 §5.2）。
    assert.equal(gotBody.seed, undefined, "顶层 seed 会被网关丢弃，不得只写顶层");
    const expectedSeed = deliverySeed({ ...brief, videoModel: "kling-v1-6" });
    assert.ok(Number.isInteger(expectedSeed), "种子必须是整数");
    assert.equal(gotBody.metadata?.seed, expectedSeed, "视频 metadata.seed 必须与 Brief 同源");
    // 生成审计：带公网首帧即图生视频，逐镜记录供 manifest 回显（PRD §16.13.2）。
    assert.equal(out.videoMode, "image-to-video", "带公网首帧的镜次应记录为图生视频");
  } finally {
    stub.close();
  }
});

test("generateSceneVideo：异步任务轮询直至 succeeded（output 对象含 url）", async () => {
  const calls = { poll: 0 };
  const stub = await listen(async (req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.method === "POST" && req.url === "/videos/generations") {
      await readBody(req);
      res.end(JSON.stringify({ id: "task-async", status: "pending" }));
    } else if (req.method === "GET" && req.url === "/videos/task-async") {
      calls.poll++;
      if (calls.poll >= 3) res.end(JSON.stringify({ id: "task-async", status: "succeeded", output: { url: "https://cdn.example.com/out2.mp4" } }));
      else res.end(JSON.stringify({ id: "task-async", status: "processing" }));
    } else {
      res.statusCode = 404; res.end();
    }
  });
  process.env.PROMO_VIDEO_POLL_MS = "30";
  try {
    const out = await withReal(stub, () =>
      generateSceneVideo(scene, { ...brief, videoModel: "veo-3" }));
    assert.equal(out.videoUrl, "https://cdn.example.com/out2.mp4");
    assert.ok(calls.poll >= 3, `应轮询多次而非一次成功（实际 ${calls.poll} 次）`);
  } finally {
    stub.close();
    delete process.env.PROMO_VIDEO_POLL_MS;
  }
});

test("generateSceneVideo：GET /videos/{id} 404 → 备选 /videos/generations/{id}", async () => {
  const stub = await listen(async (req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.method === "POST" && req.url === "/videos/generations") {
      await readBody(req);
      res.end(JSON.stringify({ id: "task-404" }));
    } else if (req.method === "GET" && req.url === "/videos/task-404") {
      res.statusCode = 404; res.end("not found");
    } else if (req.method === "GET" && req.url === "/videos/generations/task-404") {
      res.end(JSON.stringify({ status: "completed", data: [{ video_url: "https://cdn.example.com/out3.mp4" }] }));
    } else {
      res.statusCode = 404; res.end();
    }
  });
  process.env.PROMO_VIDEO_POLL_MS = "30";
  try {
    const out = await withReal(stub, () =>
      generateSceneVideo(scene, { ...brief, videoModel: "runway-gen4" }));
    assert.equal(out.videoUrl, "https://cdn.example.com/out3.mp4", "备选端点产物应被解析");
  } finally {
    stub.close();
    delete process.env.PROMO_VIDEO_POLL_MS;
  }
});

test("generateSceneVideo：任务失败 → 抛错（带渠道 error 信息）", async () => {
  const stub = await listen(async (req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.method === "POST" && req.url === "/videos/generations") {
      await readBody(req);
      res.end(JSON.stringify({ id: "task-fail" }));
    } else if (req.method === "GET" && req.url === "/videos/task-fail") {
      res.end(JSON.stringify({ id: "task-fail", status: "failed", error: "content policy violation" }));
    } else {
      res.statusCode = 404; res.end();
    }
  });
  process.env.PROMO_VIDEO_POLL_MS = "30";
  try {
    await assert.rejects(
      withReal(stub, () => generateSceneVideo(scene, { ...brief, videoModel: "sora-2" })),
      /content policy violation/
    );
  } finally {
    stub.close();
    delete process.env.PROMO_VIDEO_POLL_MS;
  }
});

test("generateSceneVideo：轮询超时 → 抛错（PROMO_VIDEO_TIMEOUT_MS 生效）", async () => {
  const stub = await listen(async (req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.method === "POST" && req.url === "/videos/generations") {
      await readBody(req);
      res.end(JSON.stringify({ id: "task-hang" }));
    } else if (req.method === "GET" && req.url === "/videos/task-hang") {
      res.end(JSON.stringify({ id: "task-hang", status: "processing" })); // 永不完成
    } else {
      res.statusCode = 404; res.end();
    }
  });
  process.env.PROMO_VIDEO_POLL_MS = "20";
  process.env.PROMO_VIDEO_TIMEOUT_MS = "120";
  try {
    await assert.rejects(
      withReal(stub, () => generateSceneVideo(scene, { ...brief, videoModel: "hailuo-02" })),
      /超时/
    );
  } finally {
    stub.close();
    delete process.env.PROMO_VIDEO_POLL_MS;
    delete process.env.PROMO_VIDEO_TIMEOUT_MS;
  }
});

test("generateSceneVideo：未指定视频模型 → 抛错", async () => {
  const stub = await listen((_req, res) => { res.statusCode = 404; res.end(); });
  try {
    await assert.rejects(
      withReal(stub, () => generateSceneVideo(scene, { ...brief, videoModel: "" })),
      /未指定视频模型/
    );
  } finally {
    stub.close();
  }
});

test("generateSceneVideo：复数端点 404 → 自动回退单数 /video/generations（new-api 实测）", async () => {
  const hits = { plural: 0, single: 0 };
  const stub = await listen(async (req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.method === "POST" && req.url === "/videos/generations") {
      hits.plural++;
      res.statusCode = 404;
      res.end("Invalid URL"); // new-api v0.13.2 对复数路由的实际应答
    } else if (req.method === "POST" && req.url === "/video/generations") {
      hits.single++;
      await readBody(req);
      res.end(JSON.stringify({ id: "task-singular", status: "queued" }));
    } else if (req.method === "GET" && req.url === "/video/generations/task-singular") {
      res.end(JSON.stringify({ status: "succeeded", data: [{ url: "https://cdn.example.com/out-single.mp4" }] }));
    } else {
      res.statusCode = 404; res.end();
    }
  });
  process.env.PROMO_VIDEO_POLL_MS = "30";
  try {
    const out = await withReal(stub, () =>
      generateSceneVideo(scene, { ...brief, videoModel: "doubao-seedance-2-0-260128" }));
    assert.equal(hits.plural, 1, "应先尝试复数端点");
    assert.equal(hits.single, 1, "复数 404 后应回退单数端点提交");
    assert.equal(out.videoUrl, "https://cdn.example.com/out-single.mp4", "单数端点产物应被解析");
  } finally {
    stub.close();
    delete process.env.PROMO_VIDEO_POLL_MS;
  }
});

test("generateSceneVideo：new-api 任务包装 {code,data:{status:SUCCESS,result_url}} 解包取 URL", async () => {
  const stub = await listen(async (req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.method === "POST" && req.url === "/video/generations") {
      await readBody(req);
      res.end(JSON.stringify({ code: "success", data: { id: "task-napi", status: "queued" } }));
    } else if (req.method === "GET" && req.url === "/video/generations/task-napi") {
      res.end(JSON.stringify({ code: "success", data: { id: "task-napi", status: "SUCCESS", result_url: "https://cdn.example.com/out-napi.mp4" } }));
    } else {
      res.statusCode = 404; res.end();
    }
  });
  process.env.PROMO_VIDEO_POLL_MS = "30";
  try {
    const out = await withReal(stub, () =>
      generateSceneVideo(scene, { ...brief, videoModel: "doubao-seedance-2-0-260128" }));
    assert.equal(out.videoUrl, "https://cdn.example.com/out-napi.mp4", "result_url 应被 unwrap 后提取");
    assert.equal(out.model, "doubao-seedance-2-0-260128");
  } finally {
    stub.close();
    delete process.env.PROMO_VIDEO_POLL_MS;
  }
});

test("generateSceneVideo：new-api 任务 FAILURE → 抛错（带 fail_reason）", async () => {
  const stub = await listen(async (req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.method === "POST" && req.url === "/video/generations") {
      await readBody(req);
      res.end(JSON.stringify({ code: "success", data: { id: "task-fail-napi" } }));
    } else if (req.method === "GET" && req.url === "/video/generations/task-fail-napi") {
      res.end(JSON.stringify({ code: "success", data: { id: "task-fail-napi", status: "FAILURE", fail_reason: "invalid image url" } }));
    } else {
      res.statusCode = 404; res.end();
    }
  });
  process.env.PROMO_VIDEO_POLL_MS = "30";
  try {
    await assert.rejects(
      withReal(stub, () => generateSceneVideo(scene, { ...brief, videoModel: "doubao-seedance-2-0-260128" })),
      /invalid image url/
    );
  } finally {
    stub.close();
    delete process.env.PROMO_VIDEO_POLL_MS;
  }
});

test("generateSceneVideo：DEMO 模式返回 stub（不产生网络调用）", async () => {
  const before = process.env.PROMO_PROVIDER_MODE;
  process.env.PROMO_PROVIDER_MODE = "demo";
  try {
    const out = await generateSceneVideo(scene, { ...brief, videoModel: "kling-v1-6" });
    assert.equal(out.videoUrl, null, "demo 不产出真实片段");
    assert.equal(out.kind, "video-stub");
  } finally {
    if (before === undefined) delete process.env.PROMO_PROVIDER_MODE;
    else process.env.PROMO_PROVIDER_MODE = before;
  }
});

test("generateSceneVideo：横屏画布尺寸与比例进入 provider payload", async () => {
  let gotBody = null;
  const stub = await listen(async (req, res) => {
    if (req.method === "POST" && req.url === "/videos/generations") {
      gotBody = await readBody(req);
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ url: "https://cdn.example.com/landscape.mp4" }));
    } else {
      res.statusCode = 404; res.end();
    }
  });
  try {
    await withReal(stub, () => generateSceneVideo(scene, {
      ...brief,
      videoModel: "kling-v1-6",
      canvasPreset: "social-landscape",
    }));
    assert.equal(gotBody.aspect_ratio, "16:9");
    assert.equal(gotBody.width, 1920);
    assert.equal(gotBody.height, 1080);
    assert.equal(gotBody.size, "1920x1080");
  } finally {
    stub.close();
  }
});

test("generateSceneVideo：首帧只发送图像渠道的公网 URL，绝不发送 data URL 或本机地址", async () => {
  const previousOutputRoot = process.env.PROMO_OUTPUT_ROOT;
  const outputRoot = fs.mkdtempSync(path.join(os.tmpdir(), "promo-i2v-"));
  process.env.PROMO_OUTPUT_ROOT = outputRoot;
  const paths = artifactPaths("video-provider-i2v");
  const mediaPath = path.join(paths.scenes, "scene-image.png");
  execFileSync("ffmpeg", ["-y", "-f", "lavfi", "-i", "color=c=purple:s=1080x1920", "-frames:v", "1", mediaPath], { stdio: "pipe" });
  let gotBody = null;
  const stub = await listen(async (req, res) => {
    if (req.method === "POST" && req.url === "/videos/generations") {
      gotBody = await readBody(req);
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ url: "https://cdn.example.com/result.mp4" }));
    } else {
      res.statusCode = 404; res.end();
    }
  });
  try {
    // 说明：上游视频渠道自行下载首帧，data: 与 localhost 实测被拒；这里锁定「只发公网 URL」契约。
    const localScene = {
      ...scene,
      mediaUrl: "file:///tmp/local-standard.png",
      frameImageUrl: "https://ark-content-generation.example/scene-1.jpeg",
      mediaPath,
    };
    await withReal(stub, () => generateSceneVideo(localScene, {
      ...brief,
      videoModel: "kling-v1-6",
    }, { scenesWorkspace: paths.scenes }));
    assert.equal(gotBody.image, "https://ark-content-generation.example/scene-1.jpeg", "应发送公网首帧 URL");
    assert.equal(/^data:/i.test(gotBody.image), false, "不得发送 data URL");
    assert.equal(gotBody.image.includes(mediaPath), false, "请求体不得含本地路径");
    // 渠道硬校验字段：整数秒 duration 与显式比例，缺失会被上游直接拒绝。
    assert.equal(gotBody.duration, 4, "场景 2.68s 应向上取整并夹到下限 4s");
    assert.equal(gotBody.ratio, "9:16");
    assert.equal(gotBody.aspect_ratio, "9:16");
  } finally {
    stub.close();
    if (previousOutputRoot === undefined) delete process.env.PROMO_OUTPUT_ROOT;
    else process.env.PROMO_OUTPUT_ROOT = previousOutputRoot;
    fs.rmSync(outputRoot, { recursive: true, force: true });
  }
});

test("generateSceneVideo：没有公网首帧 URL → 退化为文生，不发送 image", async () => {
  let gotBody = null;
  const stub = await listen(async (req, res) => {
    if (req.method === "POST" && req.url === "/videos/generations") {
      gotBody = await readBody(req);
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ url: "https://cdn.example.com/text2video.mp4" }));
    } else {
      res.statusCode = 404; res.end();
    }
  });
  try {
    const noFrame = {
      ...scene,
      mediaUrl: "data:image/png;base64,iVBORw0KGgo=",
      mediaPath: path.join(os.tmpdir(), "never-uploaded.png"),
      frameImageUrl: "http://127.0.0.1:6777/local.png",
    };
    const out = await withReal(stub, () =>
      generateSceneVideo(noFrame, { ...brief, videoModel: "kling-v1-6" }));
    assert.equal(out.videoUrl, "https://cdn.example.com/text2video.mp4");
    assert.equal("image" in gotBody, false, "无公网 URL 时不得发送 image 字段");
    assert.match(gotBody.prompt, /产品特写/);
    // 退化只改输入形态，不得丢风格锚点。
    assert.match(gotBody.prompt, /全片统一风格锚点/, "文生退化路径同样必须携带风格锚点");
    assert.equal(out.videoMode, "text-to-video", "无公网首帧时输入形态必须记录为文生视频");
    assert.equal(gotBody.metadata?.seed, deliverySeed({ ...brief, videoModel: "kling-v1-6" }), "文生退化路径同样携带固定 seed");
  } finally {
    stub.close();
  }
});

test("generateSceneVideo：任务失败且 error 为对象 → 错误信息含上游 message，无 [object Object]", async () => {
  const stub = await listen(async (req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.method === "POST" && req.url === "/videos/generations") {
      await readBody(req);
      res.end(JSON.stringify({ id: "task-err-obj" }));
    } else if (req.method === "GET" && req.url === "/videos/task-err-obj") {
      // minimax-h3 实测把失败原因放在 error:{code,message}，直接拼模板会渲染成 [object Object]。
      res.end(JSON.stringify({ id: "task-err-obj", status: "FAILURE", error: { code: "invalid_parameter", message: "ratio is required" } }));
    } else {
      res.statusCode = 404; res.end();
    }
  });
  process.env.PROMO_VIDEO_POLL_MS = "30";
  try {
    await assert.rejects(
      withReal(stub, () => generateSceneVideo(scene, { ...brief, videoModel: "minimax-h3" })),
      (error) => {
        assert.match(error.message, /ratio is required/);
        assert.equal(error.message.includes("[object Object]"), false);
        return true;
      }
    );
  } finally {
    stub.close();
    delete process.env.PROMO_VIDEO_POLL_MS;
  }
});

test("generateSceneVideo：成功地址仅在 metadata.url（minimax-h3 实测）也能解析", async () => {
  const stub = await listen(async (req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.method === "POST" && req.url === "/videos/generations") {
      await readBody(req);
      res.end(JSON.stringify({ id: "task-meta-url" }));
    } else if (req.method === "GET" && req.url === "/videos/task-meta-url") {
      res.end(JSON.stringify({ id: "task-meta-url", status: "SUCCESS", metadata: { url: "https://cdn.example.com/from-metadata.mp4" } }));
    } else {
      res.statusCode = 404; res.end();
    }
  });
  process.env.PROMO_VIDEO_POLL_MS = "30";
  try {
    const out = await withReal(stub, () =>
      generateSceneVideo(scene, { ...brief, videoModel: "minimax-h3" }));
    assert.equal(out.videoUrl, "https://cdn.example.com/from-metadata.mp4");
    assert.equal(out.model, "minimax-h3");
  } finally {
    stub.close();
    delete process.env.PROMO_VIDEO_POLL_MS;
  }
});

test("generateSceneVideo：轮询择优 —— /videos/{id} 空壳响应不得遮蔽权威端点失败（2026-09 实测超时根因）", async () => {
  const hits = { authoritative: 0, shell: 0 };
  const stub = await listen(async (req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.method === "POST" && req.url === "/video/generations") {
      await readBody(req);
      res.end(JSON.stringify({ code: "success", data: { id: "task-shell" } }));
    } else if (req.method === "GET" && req.url === "/video/generations/task-shell") {
      hits.authoritative++;
      // new-api 权威任务形态：状态与失败原因都在这条端点，只有它给出 FAILURE。
      res.end(JSON.stringify({
        code: "success",
        data: {
          id: "task-shell",
          status: "FAILURE",
          fail_reason: "upstream returned unrecognized message",
          result_url: "upstream returned unrecognized message",
        },
      }));
    } else if (req.method === "GET" && req.url === "/videos/generations/task-shell") {
      res.statusCode = 404; res.end("Invalid URL");
    } else if (req.method === "GET" && req.url === "/videos/task-shell") {
      hits.shell++;
      // 上游原始形态：200 但没有状态结论、没有失败原因 —— 只认首个 200 就会一直轮到超时。
      res.end(JSON.stringify({ status: "unknown", metadata: { url: "" } }));
    } else {
      res.statusCode = 404; res.end();
    }
  });
  process.env.PROMO_VIDEO_POLL_MS = "20";
  process.env.PROMO_VIDEO_TIMEOUT_MS = "4000";
  const startedAt = Date.now();
  try {
    await assert.rejects(
      withReal(stub, () => generateSceneVideo(scene, { ...brief, videoModel: "minimax-h3" })),
      (error) => {
        assert.match(error.message, /unrecognized message/, "应带出权威端点里的 fail_reason");
        assert.equal(/超时/.test(error.message), false, "应在轮询超时前按失败终止");
        return true;
      }
    );
    const elapsed = Date.now() - startedAt;
    assert.ok(elapsed < 3000, `不应等到超时（实际 ${elapsed}ms）`);
    assert.ok(hits.authoritative >= 1, "应查询权威端点 /video/generations/{id}");
  } finally {
    stub.close();
    delete process.env.PROMO_VIDEO_POLL_MS;
    delete process.env.PROMO_VIDEO_TIMEOUT_MS;
  }
});

test("generateSceneVideo：result_url 非 http(s)（错误文案）不得被当成成片地址", async () => {
  const stub = await listen(async (req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.method === "POST" && req.url === "/video/generations") {
      await readBody(req);
      res.end(JSON.stringify({ code: "success", data: { id: "task-bad-url" } }));
    } else if (req.method === "GET" && req.url === "/video/generations/task-bad-url") {
      // 上游把失败文案填进 result_url：不校验协议就会被当成产物地址去下载。
      res.end(JSON.stringify({
        code: "success",
        data: { id: "task-bad-url", status: "SUCCESS", result_url: "upstream returned unrecognized message" },
      }));
    } else {
      res.statusCode = 404; res.end();
    }
  });
  process.env.PROMO_VIDEO_POLL_MS = "20";
  try {
    await assert.rejects(
      withReal(stub, () => generateSceneVideo(scene, { ...brief, videoModel: "minimax-h3" })),
      (error) => {
        assert.match(error.message, /完成但未返回 URL/);
        assert.equal(error.message.includes("unrecognized message"), true, "原始响应应保留在错误上下文里，但不当作 URL");
        return true;
      }
    );
  } finally {
    stub.close();
    delete process.env.PROMO_VIDEO_POLL_MS;
  }
});

test("generateSceneVideo：权威端点 result_url 为网关回环地址时，必须改用同响应的公网 metadata.url（2026-09-22 真实验收根因）", async () => {
  // 说明：new-api 的 /video/generations/{id} 会把容器内回环地址回填进 result_url（实测 http://localhost:3000/v1/videos/{id}/content，
  // 宿主机 ECONNREFUSED，改写成宿主端口后又被网关自身的私网下载策略 403 拒绝），真正的成片地址在同一响应的 data.metadata.url
  // （TOS 签名地址）。旧的「首个 http(s) 命中即返回」会让已经出片的付费任务在下载阶段失败。
  const tosUrl = "https://ark-acg-cn-beijing.tos-cn-beijing.volces.com/doubao-seedance-2-0/out.mp4?X-Tos-Signature=abc";
  const loopback = "http://localhost:3000/v1/videos/task-loopback/content";
  const stub = await listen(async (req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.method === "POST" && req.url === "/video/generations") {
      await readBody(req);
      res.end(JSON.stringify({ code: "success", data: { id: "task-loopback" } }));
      return;
    }
    if (req.method === "GET" && req.url === "/video/generations/task-loopback") {
      res.end(JSON.stringify({
        code: "success",
        data: {
          id: "task-loopback",
          status: "SUCCESS",
          fail_reason: "",
          result_url: loopback,
          data: { id: "task_upstream", model: "doubao-seedance-2-0-260128", status: "completed", metadata: { url: tosUrl } },
        },
      }));
      return;
    }
    if (req.method === "GET" && req.url === "/videos/task-loopback") {
      res.end(JSON.stringify({ id: "task-loopback", status: "completed", metadata: { url: tosUrl } }));
      return;
    }
    res.statusCode = 404; res.end();
  });
  process.env.PROMO_VIDEO_POLL_MS = "20";
  try {
    const out = await withReal(stub, () => generateSceneVideo(scene, { ...brief, videoModel: "doubao-seedance-2-0-260128" }));
    assert.equal(out.videoUrl, tosUrl, "必须取公网 metadata.url，不得把回环 result_url 当成成片地址");
  } finally {
    stub.close();
    delete process.env.PROMO_VIDEO_POLL_MS;
  }
});

test("generateSceneVideo：只有回环地址可用时不得空等超时，仍交出该地址由物化阶段报真实原因", async () => {
  // 说明：自建/内网存储部署确实可能只给内网地址。此时不能判失败让整条 run 白跑，也不该一直轮询；
  // 交出地址让下载重试窗口给出带 host 的真实错误，是能同时满足可用性与可观测性的选择。
  const loopback = "http://localhost:3000/v1/videos/task-only-loopback/content";
  const stub = await listen(async (req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.method === "POST" && req.url === "/video/generations") {
      await readBody(req);
      res.end(JSON.stringify({ code: "success", data: { id: "task-only-loopback" } }));
      return;
    }
    if (req.method === "GET" && req.url === "/video/generations/task-only-loopback") {
      res.end(JSON.stringify({ code: "success", data: { id: "task-only-loopback", status: "SUCCESS", result_url: loopback } }));
      return;
    }
    res.statusCode = 404; res.end();
  });
  process.env.PROMO_VIDEO_POLL_MS = "20";
  const startedAt = Date.now();
  try {
    const out = await withReal(stub, () => generateSceneVideo(scene, { ...brief, videoModel: "minimax-h3" }));
    assert.equal(out.videoUrl, loopback);
    assert.ok(Date.now() - startedAt < 3000, "不得为了找公网地址一直轮询到超时");
  } finally {
    stub.close();
    delete process.env.PROMO_VIDEO_POLL_MS;
  }
});

test("generateSceneVideo：上游瞬时故障重试后成功（unrecognized message，2026-09 实测占约 1/3）", async () => {
  let submissions = 0;
  const stub = await listen(async (req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.method === "POST" && req.url === "/videos/generations") {
      await readBody(req);
      submissions++;
      res.end(JSON.stringify({ code: "success", data: { id: `task-retry-${submissions}` } }));
    } else if (req.method === "GET" && /^\/video\/generations\/task-retry-/u.test(req.url)) {
      // 第一次任务是上游偶发故障，第二次成功 —— 重试必须能把偶发故障吃掉。
      if (submissions === 1) {
        res.end(JSON.stringify({ code: "success", data: { id: "t", status: "FAILURE", fail_reason: "upstream returned unrecognized message" } }));
      } else {
        res.end(JSON.stringify({ code: "success", data: { id: "t", status: "SUCCESS", result_url: "https://cdn.example.com/retry-ok.mp4" } }));
      }
    } else {
      res.statusCode = 404; res.end();
    }
  });
  process.env.PROMO_VIDEO_POLL_MS = "20";
  process.env.PROMO_VIDEO_RETRY_BACKOFF_MS = "10";
  try {
    const out = await withReal(stub, () =>
      generateSceneVideo(scene, { ...brief, videoModel: "minimax-h3" }));
    assert.equal(out.videoUrl, "https://cdn.example.com/retry-ok.mp4");
    assert.equal(submissions, 2, "应重试一次并提交第二个任务");
  } finally {
    stub.close();
    delete process.env.PROMO_VIDEO_POLL_MS;
    delete process.env.PROMO_VIDEO_RETRY_BACKOFF_MS;
  }
});

test("generateSceneVideo：契约类错误（4xx）不重试，避免多花一次付费调用", async () => {
  let submissions = 0;
  const stub = await listen(async (req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.method === "POST" && req.url === "/videos/generations") {
      await readBody(req);
      submissions++;
      res.statusCode = 400;
      res.end(JSON.stringify({ error: { code: "invalid_parameter", message: "body.duration: Field required" } }));
    } else {
      res.statusCode = 404; res.end();
    }
  });
  process.env.PROMO_VIDEO_RETRY_BACKOFF_MS = "10";
  try {
    await assert.rejects(
      withReal(stub, () =>
        generateSceneVideo(scene, { ...brief, videoModel: "minimax-h3" })),
      (error) => {
        assert.match(error.message, /Field required|400/u);
        return true;
      }
    );
    assert.equal(submissions, 1, "契约类错误必须只提交一次");
  } finally {
    stub.close();
    delete process.env.PROMO_VIDEO_RETRY_BACKOFF_MS;
  }
});

test("generateSceneVideo：成片下载瞬时失败只对同一 URL 重试，绝不重新提交付费生成任务（2026-09 真实验收根因）", async () => {
  const previousOutputRoot = process.env.PROMO_OUTPUT_ROOT;
  const outputRoot = fs.mkdtempSync(path.join(os.tmpdir(), "promo-download-retry-"));
  process.env.PROMO_OUTPUT_ROOT = outputRoot;
  const paths = artifactPaths("video-provider-download-retry");
  // 说明：成片必须是真实可归一化的 MP4，否则会在 FFmpeg 阶段失败，测不出「下载重试」这条边界。
  const fixtureFile = path.join(os.tmpdir(), `promo-download-fixture-${process.pid}.mp4`);
  execFileSync("ffmpeg", ["-y", "-v", "error", "-f", "lavfi", "-i", "color=c=teal:s=320x568:r=25:d=1", "-an", "-c:v", "libx264", "-pix_fmt", "yuv420p", fixtureFile], { stdio: "pipe" });
  const fixtureBytes = fs.readFileSync(fixtureFile);

  let submissions = 0;
  let downloads = 0;
  const stub = await listen(async (req, res) => {
    if (req.method === "POST" && req.url === "/videos/generations") {
      await readBody(req);
      submissions++;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ code: "success", data: { id: "task-download-retry" } }));
      return;
    }
    if (req.method === "GET" && req.url === "/video/generations/task-download-retry") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ code: "success", data: { id: "task-download-retry", status: "SUCCESS", result_url: `http://127.0.0.1:${portOf(stub)}/artifact.mp4` } }));
      return;
    }
    if (req.method === "GET" && req.url === "/artifact.mp4") {
      downloads++;
      // 前两次下载在连接层抖动，第三次返回成片：必须复用同一 URL 重试，而不是重新生成。
      if (downloads <= 2) { req.socket.destroy(); return; }
      res.writeHead(200, { "content-type": "video/mp4", "content-length": fixtureBytes.length });
      res.end(fixtureBytes);
      return;
    }
    res.statusCode = 404; res.end();
  });
  process.env.PROMO_VIDEO_POLL_MS = "20";
  process.env.PROMO_VIDEO_RETRY_BACKOFF_MS = "10";
  process.env.PROMO_MEDIA_DOWNLOAD_ATTEMPTS = "3";
  process.env.PROMO_MEDIA_DOWNLOAD_BACKOFF_MS = "10";
  try {
    const out = await withReal(stub, () => generateSceneVideo(
      { ...scene, durationSec: 1 },
      { ...brief, videoModel: "minimax-h3", canvasPreset: "social-portrait" },
      { inputsWorkspace: paths.inputs, scenesWorkspace: paths.scenes },
    ));
    assert.equal(submissions, 1, "下载失败不得触发第二次付费生成");
    assert.equal(downloads, 3, "应对同一成片 URL 重试下载");
    assert.ok(out.videoPath && fs.existsSync(out.videoPath), "重试后应产出物化片段");
    assert.match(out.videoUrl, /^file:/u);
  } finally {
    stub.close();
    delete process.env.PROMO_VIDEO_POLL_MS;
    delete process.env.PROMO_VIDEO_RETRY_BACKOFF_MS;
    delete process.env.PROMO_MEDIA_DOWNLOAD_ATTEMPTS;
    delete process.env.PROMO_MEDIA_DOWNLOAD_BACKOFF_MS;
    if (previousOutputRoot === undefined) delete process.env.PROMO_OUTPUT_ROOT;
    else process.env.PROMO_OUTPUT_ROOT = previousOutputRoot;
    fs.rmSync(outputRoot, { recursive: true, force: true });
    fs.rmSync(fixtureFile, { force: true });
  }
});

test("generateSceneVideo：上游生成瞬时失败仍会重试生成（与下载重试边界互不影响）", async () => {
  let submissions = 0;
  const stub = await listen(async (req, res) => {
    if (req.method === "POST" && req.url === "/videos/generations") {
      await readBody(req);
      submissions++;
      res.setHeader("content-type", "application/json");
      if (submissions === 1) { res.statusCode = 500; res.end(JSON.stringify({ error: { message: "upstream 5xx" } })); return; }
      res.end(JSON.stringify({ data: [{ url: "https://cdn.example.com/second-try.mp4" }] }));
      return;
    }
    res.statusCode = 404; res.end();
  });
  process.env.PROMO_VIDEO_RETRY_BACKOFF_MS = "10";
  try {
    const out = await withReal(stub, () => generateSceneVideo(scene, { ...brief, videoModel: "minimax-h3" }));
    assert.equal(out.videoUrl, "https://cdn.example.com/second-try.mp4");
    assert.equal(submissions, 2, "生成阶段 5xx 应重试一次");
  } finally {
    stub.close();
    delete process.env.PROMO_VIDEO_RETRY_BACKOFF_MS;
  }
});

test("generateSceneVideo：主模型尝试耗尽后按降级链换渠道重试整镜（上游整段故障自救）", async () => {
  // 说明：上游整段故障时同一模型重试再多次也出不来片，只有换渠道才行；失败任务由网关冲正，净成本为 0。
  const submissions = [];
  const stub = await listen(async (req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.method === "POST" && req.url === "/videos/generations") {
      const body = await readBody(req);
      submissions.push(body.model);
      res.end(JSON.stringify({ code: "success", data: { id: `task-fb-${body.model}` } }));
      return;
    }
    if (req.method === "GET" && /^\/video\/generations\/task-fb-/u.test(req.url)) {
      const model = decodeURIComponent(req.url.split("task-fb-")[1]);
      if (model === "minimax-h3") {
        res.end(JSON.stringify({ code: "success", data: { id: "t", status: "FAILURE", fail_reason: "upstream returned unrecognized message" } }));
      } else {
        res.end(JSON.stringify({ code: "success", data: { id: "t", status: "SUCCESS", result_url: `https://cdn.example.com/${model}.mp4` } }));
      }
      return;
    }
    res.statusCode = 404; res.end();
  });
  process.env.PROMO_VIDEO_POLL_MS = "20";
  process.env.PROMO_VIDEO_RETRY_BACKOFF_MS = "10";
  try {
    const out = await withReal(stub, () => generateSceneVideo(
      scene,
      { ...brief, videoModel: "minimax-h3", videoModelFallbacks: ["7zhe-seedance"] },
    ));
    assert.equal(out.videoUrl, "https://cdn.example.com/7zhe-seedance.mp4");
    assert.equal(out.model, "7zhe-seedance", "返回的应是真正出片的模型，供审计与按实际模型计价");
    assert.deepEqual(submissions, ["minimax-h3", "minimax-h3", "7zhe-seedance"], "主模型按尝试次数重试后才换渠道");
  } finally {
    stub.close();
    delete process.env.PROMO_VIDEO_POLL_MS;
    delete process.env.PROMO_VIDEO_RETRY_BACKOFF_MS;
  }
});

test("generateSceneVideo：全部候选都失败才抛错，且错误保留上游真实原因", async () => {
  let submissions = 0;
  const stub = await listen(async (req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.method === "POST" && req.url === "/videos/generations") {
      await readBody(req); submissions++;
      res.end(JSON.stringify({ code: "success", data: { id: `task-allfail-${submissions}` } }));
      return;
    }
    if (req.method === "GET" && /^\/video\/generations\/task-allfail-/u.test(req.url)) {
      res.end(JSON.stringify({ code: "success", data: { id: "t", status: "FAILURE", fail_reason: "upstream returned unrecognized message" } }));
      return;
    }
    res.statusCode = 404; res.end();
  });
  process.env.PROMO_VIDEO_POLL_MS = "20";
  process.env.PROMO_VIDEO_RETRY_BACKOFF_MS = "10";
  try {
    await assert.rejects(
      withReal(stub, () => generateSceneVideo(
        scene,
        { ...brief, videoModel: "minimax-h3", videoModelFallbacks: ["7zhe-seedance"] },
      )),
      (error) => {
        assert.match(error.message, /unrecognized message/u);
        return true;
      }
    );
    // 每个候选模型各有自己的尝试额度：主模型 2 次 + 降级模型 2 次，全部耗尽才判定整镜失败。
    assert.equal(submissions, 4, "主模型 2 次 + 降级模型 2 次");
  } finally {
    stub.close();
    delete process.env.PROMO_VIDEO_POLL_MS;
    delete process.env.PROMO_VIDEO_RETRY_BACKOFF_MS;
  }
});

test("generateSceneVideo：契约类错误不触发换渠道（换模型同样会失败，只会多花钱）", async () => {
  const submissions = [];
  const stub = await listen(async (req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.method === "POST" && req.url === "/videos/generations") {
      const body = await readBody(req);
      submissions.push(body.model);
      res.statusCode = 400;
      res.end(JSON.stringify({ error: { code: "invalid_parameter", message: "body.duration: Field required" } }));
      return;
    }
    res.statusCode = 404; res.end();
  });
  process.env.PROMO_VIDEO_RETRY_BACKOFF_MS = "10";
  try {
    await assert.rejects(
      withReal(stub, () => generateSceneVideo(
        scene,
        { ...brief, videoModel: "minimax-h3", videoModelFallbacks: ["7zhe-seedance"] },
      )),
      /Field required|400/u
    );
    assert.deepEqual(submissions, ["minimax-h3"], "契约类错误必须立即失败且不换渠道");
  } finally {
    stub.close();
    delete process.env.PROMO_VIDEO_RETRY_BACKOFF_MS;
  }
});

test("generateSceneVideo：渠道级不可用（上游余额不足 403）跳过剩余尝试并降级到下一个候选", async () => {
  // 说明：2026-09-22 真实验收中主模型整段故障降级到 7zhe-seedance 后，该渠道上游账户余额不足返回
  // 403 insufficient_user_quota。旧逻辑把它当契约错误立即抛出，候选链里本可救场的 seedance-2.0 永远
  // 没被尝试，整条已付费 run 被判失败。这里锁定「不重发同一模型、直接换下一个候选」的语义。
  const submissions = [];
  const stub = await listen(async (req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.method === "POST" && req.url === "/videos/generations") {
      const body = await readBody(req);
      submissions.push(body.model);
      if (body.model === "7zhe-seedance") {
        res.statusCode = 403;
        res.end(JSON.stringify({ code: "fail_to_fetch_task", message: JSON.stringify({ code: 1, message: "预扣费额度失败, 用户剩余额度: ¥1.040006, 需要预扣费额度: ¥3.264000", error: { code: "insufficient_user_quota" } }) }));
        return;
      }
      res.end(JSON.stringify({ data: [{ url: "https://cdn.example.com/quota-failover.mp4" }] }));
      return;
    }
    res.statusCode = 404; res.end();
  });
  process.env.PROMO_VIDEO_ATTEMPTS = "2";
  process.env.PROMO_VIDEO_RETRY_BACKOFF_MS = "10";
  try {
    const out = await withReal(stub, () => generateSceneVideo(
      scene,
      { ...brief, videoModel: "7zhe-seedance", videoModelFallbacks: ["seedance-2.0"] },
    ));
    assert.equal(out.model, "seedance-2.0", "应在渠道不可用后换成下一个候选出片");
    assert.equal(out.videoUrl, "https://cdn.example.com/quota-failover.mp4");
    // 余额不足重发同一模型必然同样失败，必须只提交 1 次后立即降级（而不是用满 2 次尝试额度）。
    assert.deepEqual(submissions, ["7zhe-seedance", "seedance-2.0"], "渠道不可用不得重发同一模型");
  } finally {
    stub.close();
    delete process.env.PROMO_VIDEO_ATTEMPTS;
    delete process.env.PROMO_VIDEO_RETRY_BACKOFF_MS;
  }
});

test("generateSceneVideo：最后一个候选渠道不可用时才抛错（保留上游真实原因）", async () => {
  const submissions = [];
  const stub = await listen(async (req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.method === "POST" && req.url === "/videos/generations") {
      const body = await readBody(req);
      submissions.push(body.model);
      res.statusCode = 403;
      res.end(JSON.stringify({ error: { code: "insufficient_user_quota", message: "预扣费额度失败, 用户剩余额度: ¥1.040006" } }));
      return;
    }
    res.statusCode = 404; res.end();
  });
  process.env.PROMO_VIDEO_ATTEMPTS = "2";
  process.env.PROMO_VIDEO_RETRY_BACKOFF_MS = "10";
  try {
    await assert.rejects(
      withReal(stub, () => generateSceneVideo(
        scene,
        { ...brief, videoModel: "7zhe-seedance", videoModelFallbacks: ["seedance-2.0"] },
      )),
      /insufficient_user_quota|预扣费额度失败/u,
    );
    assert.deepEqual(submissions, ["7zhe-seedance", "seedance-2.0"], "每个候选各提交一次后耗尽");
  } finally {
    stub.close();
    delete process.env.PROMO_VIDEO_ATTEMPTS;
    delete process.env.PROMO_VIDEO_RETRY_BACKOFF_MS;
  }
});

test("generateSceneVideo：首帧图被上游内容审核拒绝 → 去掉首帧退文生后同模型重试出片", async () => {
  // 说明：2026-09-22 真实验收中 doubao-seedance-2-0-260128 返回 400
  // InputImageSensitiveContentDetected.PrivacyInformation（may contain real person），旧逻辑把它当契约错误立即抛出，
  // 整条已付费 run 因一张图被判失败。同渠道纯文生（usage.input_image_count=0）实测可出片，因此必须去掉首帧
  // 退化为文生后重试；退化是「换输入形态」而非「换参数」，不得占用尝试次数，否则 attempts=1 时根本没机会退化。
  const images = [];
  const stub = await listen(async (req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.method === "POST" && req.url === "/videos/generations") {
      const body = await readBody(req);
      images.push(body.image ?? null);
      if (body.image) {
        res.statusCode = 400;
        res.end(JSON.stringify({ code: "fail_to_fetch_task", message: JSON.stringify({ code: "seedance_upstream_error", error: { code: "InputImageSensitiveContentDetected.PrivacyInformation", message: "The request failed because the input image 'content[1]' may contain real person." } }) }));
        return;
      }
      res.end(JSON.stringify({ data: [{ url: "https://cdn.example.com/text2video-fallback.mp4" }] }));
      return;
    }
    res.statusCode = 404; res.end();
  });
  process.env.PROMO_VIDEO_ATTEMPTS = "1";
  process.env.PROMO_VIDEO_RETRY_BACKOFF_MS = "10";
  try {
    const out = await withReal(stub, () => generateSceneVideo(
      scene,
      { ...brief, videoModel: "doubao-seedance-2-0-260128" },
    ));
    assert.equal(out.videoUrl, "https://cdn.example.com/text2video-fallback.mp4");
    assert.equal(images.length, 2, "应先以带首帧被拒，再退化文生重试一次");
    assert.match(String(images[0]), /^https:\/\//u, "首次提交必须带首帧公网 URL");
    assert.equal(images[1], null, "退化重试不得再发送首帧图片");
    assert.equal(out.videoMode, "text-to-video", "被审核拒绝后实际以文生出片，审计必须如实记录");
  } finally {
    stub.close();
    delete process.env.PROMO_VIDEO_ATTEMPTS;
    delete process.env.PROMO_VIDEO_RETRY_BACKOFF_MS;
  }
});

test("generateSceneVideo：首帧被拒后后续候选不得再上传同一张图（场景级退化标记）", async () => {
  // 说明：候选链里每个渠道下载的都是同一张首帧、审核口径同源，因此一个渠道判定该图不可用后，
  // 后续候选再送同一张图只会重复被拒并重复产生一次付费提交。退化标记必须按整镜记，不能按模型记。
  const images = [];
  const stub = await listen(async (req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.method === "POST" && req.url === "/videos/generations") {
      const body = await readBody(req);
      images.push(body.image ?? null);
      if (body.model === "doubao-seedance-2-0-260128") {
        if (body.image) {
          res.statusCode = 400;
          res.end(JSON.stringify({ error: { code: "InputImageSensitiveContentDetected.PrivacyInformation", message: "The request failed because the input image may contain real person." } }));
        } else {
          res.statusCode = 500;
          res.end(JSON.stringify({ error: { code: "upstream_error", message: "upstream returned unrecognized message" } }));
        }
        return;
      }
      res.end(JSON.stringify({ data: [{ url: "https://cdn.example.com/next-candidate.mp4" }] }));
      return;
    }
    res.statusCode = 404; res.end();
  });
  process.env.PROMO_VIDEO_ATTEMPTS = "2";
  process.env.PROMO_VIDEO_RETRY_BACKOFF_MS = "10";
  try {
    const out = await withReal(stub, () => generateSceneVideo(
      scene,
      { ...brief, videoModel: "doubao-seedance-2-0-260128", videoModelFallbacks: ["doubao-seedance-2.0"] },
    ));
    assert.equal(out.model, "doubao-seedance-2.0", "应在退化后按候选链继续降级出片");
    assert.equal(out.videoUrl, "https://cdn.example.com/next-candidate.mp4");
    assert.equal(images.filter(Boolean).length, 1, "同一张首帧只允许上传一次，退化后各候选都走文生");
    assert.equal(images[0], "https://cdn.example.com/s1.png", "首次提交带首帧");
    assert.equal(images.slice(1).every((v) => v === null), true, "退化后所有提交都不得再带 image");
  } finally {
    stub.close();
    delete process.env.PROMO_VIDEO_ATTEMPTS;
    delete process.env.PROMO_VIDEO_RETRY_BACKOFF_MS;
  }
});

test("generateSceneVideo：重试退避按指数增长，不再使用线性步进", async () => {
  // 说明：上游故障成簇出现，指数退避才可能跑出故障窗口；用 PROMO_VIDEO_TIMEOUT_MS 之外的时钟替换风险高，
  // 因此只锁语义：base=10ms、cap=25ms 时三次退避各为 10/20/25（第 3 次被 cap 截断）。
  const waits = [];
  const originalSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (fn, ms, ...rest) => {
    // 说明：轮询间隔与退避都走 setTimeout，轮询固定设为 3ms 以便只捕获 ≥5ms 的退避等待。
    if (ms >= 5 && ms <= 1000) waits.push(ms);
    return originalSetTimeout(fn, ms, ...rest);
  };
  let submissions = 0;
  const stub = await listen(async (req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.method === "POST" && req.url === "/videos/generations") {
      const body = await readBody(req);
      submissions++;
      res.end(JSON.stringify({ code: "success", data: { id: `task-backoff-${submissions}` } }));
      return;
    }
    if (req.method === "GET" && /^\/video\/generations\/task-backoff-/u.test(req.url)) {
      if (submissions < 3) {
        res.end(JSON.stringify({ code: "success", data: { id: "t", status: "FAILURE", fail_reason: "upstream returned unrecognized message" } }));
      } else {
        res.end(JSON.stringify({ code: "success", data: { id: "t", status: "SUCCESS", result_url: "https://cdn.example.com/backoff-ok.mp4" } }));
      }
      return;
    }
    res.statusCode = 404; res.end();
  });
  process.env.PROMO_VIDEO_POLL_MS = "3";
  process.env.PROMO_VIDEO_RETRY_BACKOFF_MS = "10";
  process.env.PROMO_VIDEO_RETRY_MAX_BACKOFF_MS = "25";
  process.env.PROMO_VIDEO_ATTEMPTS = "3";
  try {
    const out = await withReal(stub, () => generateSceneVideo(scene, { ...brief, videoModel: "minimax-h3" }));
    assert.equal(out.videoUrl, "https://cdn.example.com/backoff-ok.mp4");
    assert.deepEqual(waits, [10, 20], "第 1、2 次退避应为 base ×2^(n-1)");
  } finally {
    globalThis.setTimeout = originalSetTimeout;
    stub.close();
    delete process.env.PROMO_VIDEO_POLL_MS;
    delete process.env.PROMO_VIDEO_RETRY_BACKOFF_MS;
    delete process.env.PROMO_VIDEO_RETRY_MAX_BACKOFF_MS;
    delete process.env.PROMO_VIDEO_ATTEMPTS;
  }
});
