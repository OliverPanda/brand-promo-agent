// generateSceneVideo 真实调用骨架测试：用本地 stub 网关覆盖全部路径——
//   同步返回 / 异步轮询成功 / GET 404 → 备选端点 / 任务失败 / 轮询超时 / 未指定模型 / DEMO stub。
// 说明：真实渠道若字段有出入，以目标网关为准；此测试锁定「OpenAI 兼容骨架」行为，防止回归。
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { generateSceneVideo } from "../src/mastra/providers.js";
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
