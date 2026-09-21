// M2 真实 Provider 单测（PROMO_PROVIDER_MODE=real）。
// 通过 mock globalThis.fetch 验证：请求构造（URL/鉴权/body）+ 响应解析 + _usage 回传。
// 不含真实网络；one-api 形状按 OpenAI 兼容协议。
process.env.PROMO_PROVIDER_MODE = "real";
process.env.PROMO_ONEAPI_BASE_URL = "https://one-api.example/v1";
process.env.PROMO_ONEAPI_API_KEY = "sk-test-xxxx";
process.env.PROMO_LLM_MODEL = "deepseek-v4-flash";
process.env.PROMO_IMAGE_MODEL = "doubao-seedream-4-0-250828";
process.env.PROMO_IMAGE_SIZE = "1024x576";
process.env.PROMO_TTS_MODEL = "tiny-iceberg";
process.env.PROMO_MUSIC_MODEL = "mureka-song";

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { artifactPaths } from "../src/media/artifacts.js";

const { test, after } = await import("node:test");
const assert = (await import("node:assert/strict")).default;
const { normalizeSceneVideo } = await import("../src/media/ffmpeg.js");
const providers = await import("../src/mastra/providers.js");
const {
  getProviderMode,
  generateScript,
  generateStoryboard,
  generateSceneMedia,
  generateVoiceover,
  generateMusic,
  composite,
} = providers;

const mediaRoot = fs.mkdtempSync(path.join(os.tmpdir(), "promo-provider-audio-"));
let audioRunIndex = 0;
function audioWorkspace() {
  const previous = process.env.PROMO_DATA_DIR;
  process.env.PROMO_DATA_DIR = mediaRoot;
  try {
    return artifactPaths(`provider-audio-${audioRunIndex += 1}`).audio;
  } finally {
    if (previous === undefined) delete process.env.PROMO_DATA_DIR;
    else process.env.PROMO_DATA_DIR = previous;
  }
}

function makeWav(durationSec, frequency) {
  const file = path.join(mediaRoot, `fixture-${durationSec}-${frequency}.wav`);
  execFileSync("ffmpeg", ["-y", "-f", "lavfi", "-i", `sine=frequency=${frequency}:duration=${durationSec}`, "-c:a", "pcm_s16le", file], { stdio: "pipe" });
  return fs.readFileSync(file);
}

const DEFAULT_SPEECH = makeWav(0.25, 440);
const DEFAULT_MUSIC = makeWav(1, 220);
let speechResponses = [];
let storyboardResponseCounts = [];
// 分镜响应封装方式：model 返回的顶层键名在不同模型间漂移，测试需逐个覆盖。
let storyboardWrapper = (scenes) => ({ scenes });
let storyboardRawContent = null;
let storyboardCallIndex = 0;
let failStoryboardAt = 0;
// 生成一条分镜记录；musicClimax 由调用方决定布尔还是 0~1 数值。
function sceneFixture(index, count, musicClimax) {
  return {
    index: index + 1,
    visualPrompt: `p${index + 1}`,
    subtitle: `s${index + 1}`,
    camera: index % 2 ? "pull" : "push",
    durationSec: 5,
    musicClimax: musicClimax ?? index === count - 1,
  };
}
function storyboardPayload(count, musicClimax) {
  return storyboardWrapper(Array.from({ length: count }, (_, index) => sceneFixture(index, count, musicClimax)));
}
let failSpeechAt = 0;
let speechCallIndex = 0;
let invalidMusicResponse = false;
// 配乐桥故障注入：分别控制 mureka-song 提交与 mureka-query 轮询的失败次数与错误形态。
let murekaSubmitFailures = 0;
let murekaQueryFailures = 0;
let murekaFailureStatus = 502;
let murekaFailureCode = "bridge_upstream_unavailable";
let murekaFailureMessage = "Mureka 上游网络暂时不可用（UND_ERR_SOCKET）";
let omniFailStatus = 0;
let omniFailText = "omni failed";
after(() => fs.rmSync(mediaRoot, { recursive: true, force: true }));

// ── fetch mock 基础设施 ──
let calls = [];
function makeRes({ ok = true, status = 200, json, text, bytes, sse } = {}) {
  const res = {
    ok,
    status,
    json: async () => json,
    text: async () => text ?? "",
    arrayBuffer: async () => (bytes ? Buffer.from(bytes) : Buffer.alloc(0)),
  };
  if (sse) {
    // SSE 通道：按帧返回 chunk，模拟长连接分片到达；最后一帧后 read() 返回 done。
    const encoder = new TextEncoder();
    let index = 0;
    res.body = {
      getReader: () => ({
        read: async () => {
          if (index >= sse.length) return { done: true, value: undefined };
          const value = encoder.encode(sse[index]);
          index += 1;
          return { done: false, value };
        },
      }),
    };
  }
  return res;
}

// 生成一段 24kHz/单声道/16bit 裸 PCM 的 base64 分片（偶数长度，满足整帧约束）。
function omniPcmChunks(durationSec, frequency = 440) {
  const samples = Math.round(24000 * durationSec);
  const pcm = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i += 1) {
    pcm.writeInt16LE(Math.round(Math.sin((2 * Math.PI * frequency * i) / 24000) * 8000), i * 2);
  }
  const mid = Math.floor(pcm.length / 2 / 2) * 2;
  return [pcm.subarray(0, mid).toString("base64"), pcm.subarray(mid).toString("base64")];
}

function omniSseFrames(base64Chunks) {
  const frames = base64Chunks.map((data) => `data: ${JSON.stringify({ choices: [{ delta: { audio: { data } } }] })}\n\n`);
  frames.push("data: [DONE]\n\n");
  return frames;
}
// 构造 Mureka 桥的 502 故障响应：one-api 把桥的错误码包在 OpenAI error 对象里。
function bridgeFailure() {
  return makeRes({
    ok: false,
    status: murekaFailureStatus,
    text: JSON.stringify({ error: { message: murekaFailureMessage, type: "upstream_error", param: "", code: murekaFailureCode } }),
  });
}

function route(path, body) {
  // 依据 path 与 body 返回对应 one-api 形状响应。
  if (path.endsWith("/chat/completions")) {
    // Mureka 协议桥：提交与轮询共用 chat/completions 形态，content 承载业务 JSON（无 response_format）。
    if (body.model === "mureka-song") {
      if (murekaSubmitFailures > 0) {
        murekaSubmitFailures -= 1;
        return bridgeFailure();
      }
      return makeRes({ json: { choices: [{ message: { content: JSON.stringify({ taskId: "t1", kind: "instrumental" }) } }] } });
    }
    if (body.model === "mureka-query") {
      if (murekaQueryFailures > 0) {
        murekaQueryFailures -= 1;
        return bridgeFailure();
      }
      const bytes = invalidMusicResponse ? Buffer.from("invalid") : DEFAULT_MUSIC;
      return makeRes({ json: { choices: [{ message: { content: JSON.stringify({ status: "succeeded", audioUrl: `data:audio/wav;base64,${bytes.toString("base64")}` }) } }] } });
    }
    if (body.modalities?.includes("audio") && body.stream === true) {
      if (omniFailStatus) return makeRes({ ok: false, status: omniFailStatus, text: omniFailText });
      return makeRes({ sse: omniSseFrames(omniPcmChunks(0.25, 330)) });
    }
    if (body.response_format?.type === "json_object") {
      // 脚本 vs 分镜：用 system 文案区分（简单但够用）
      const sys = body.messages?.[0]?.content || "";
      if (sys.includes("资深品牌文案")) {
        return makeRes({
          json: {
            choices: [{ message: { content: JSON.stringify({
              title: "T", voiceover: [
                { timecode: "00:00:00.000", text: "hi" },
                { timecode: "00:00:01.000", text: "again" },
              ],
              structure: ["a"], moodCurve: ["x"],
            }) } }],
            usage: { total_tokens: 120 },
          },
        });
      }
      // 分镜
      storyboardCallIndex += 1;
      if (storyboardCallIndex === failStoryboardAt) return makeRes({ ok: false, status: 500, text: "storyboard retry failed" });
      const sceneCount = storyboardResponseCounts.length ? storyboardResponseCounts.shift() : 2;
      const content = storyboardRawContent ?? JSON.stringify(storyboardPayload(sceneCount));
      return makeRes({ json: { choices: [{ message: { content } }], usage: { total_tokens: 200 } } });
    }
  }
  if (path.endsWith("/images/generations")) {
    return makeRes({ json: { data: [{ url: "https://cdn.example/scene.png" }] } });
  }
  if (path.endsWith("/audio/speech")) {
    speechCallIndex += 1;
    if (speechCallIndex === failSpeechAt) return makeRes({ ok: false, status: 500, text: "tts failed" });
    return makeRes({ bytes: speechResponses.length ? speechResponses.shift() : DEFAULT_SPEECH });
  }
  return makeRes({ ok: false, status: 404, text: "not found" });
}

globalThis.fetch = async (url, opts = {}) => {
  const body = opts.body ? JSON.parse(opts.body) : undefined;
  calls.push({ url, headers: opts.headers, body });
  return route(url.replace(/^https?:\/\/[^/]+/, ""), body);
};

const baseBrief = {
  brandName: "铭星科技",
  productName: "星链 Pro",
  coreSellingPoint: "一句话生成专业宣传片",
  audience: ["企业采购"],
  tones: ["科技感"],
  keyMessages: ["续航 30 小时"],
  durationSec: 30,
  language: "zh-CN",
  voiceTone: "男声",
};

test("getProviderMode 在 PROMO_PROVIDER_MODE=real 时返回 real", () => {
  assert.equal(getProviderMode(), "real");
});
test("getProviderMode 默认（未设置）返回 real（独立断言，临时改环境）", () => {
  const prev = process.env.PROMO_PROVIDER_MODE;
  delete process.env.PROMO_PROVIDER_MODE;
  assert.equal(getProviderMode(), "real");
  process.env.PROMO_PROVIDER_MODE = prev;
});

test("getProviderMode：运行时显式 demo 优先于 env real", async () => {
  const { setRuntimeConfig } = await import("../src/runtime-config.js");
  setRuntimeConfig({ providerMode: "demo" });
  try {
    assert.equal(getProviderMode(), "demo");
  } finally {
    setRuntimeConfig({ providerMode: "" });
  }
});

test("getProviderMode：持久化 runtime demo 在新进程中优先于 env real", () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "promo-runtime-mode-"));
  try {
    fs.writeFileSync(path.join(dataDir, "runtime-config.json"), JSON.stringify({ providerMode: "demo" }));
    const stdout = execFileSync(process.execPath, [
      "--input-type=module",
      "-e",
      "import('./src/runtime-config.js').then(m => process.stdout.write(m.getEffectiveProviderMode()))",
    ], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        PROMO_DATA_DIR: dataDir,
        PROMO_PERSIST: "1",
        PROMO_PROVIDER_MODE: "real",
      },
      encoding: "utf8",
      windowsHide: true,
    });
    assert.equal(stdout, "demo");
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("tests/setup.mjs：普通套件预加载无条件强制 demo", () => {
  const stdout = execFileSync(process.execPath, [
    "--import",
    "./tests/setup.mjs",
    "-e",
    "process.stdout.write(process.env.PROMO_PROVIDER_MODE)",
  ], {
    cwd: process.cwd(),
    env: { ...process.env, PROMO_PROVIDER_MODE: "real" },
    encoding: "utf8",
    windowsHide: true,
  });
  assert.equal(stdout, "demo");
});

test("generateScript 真实模式：POST /chat/completions + 解析 JSON + _usage.tokens", async () => {
  calls = [];
  const out = await generateScript(baseBrief);
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\/chat\/completions$/);
  assert.equal(calls[0].headers.Authorization, "Bearer sk-test-xxxx");
  assert.equal(calls[0].body.model, "deepseek-v4-flash");
  assert.equal(calls[0].body.response_format.type, "json_object");
  assert.ok(Array.isArray(calls[0].body.messages) && calls[0].body.messages.length === 2);
  assert.equal(out.title, "T");
  assert.equal(out._usage.tokens, 120);
  assert.equal(out.language, "zh-CN");
});

test("generateStoryboard 真实模式：返回 Scene[] 且提示词含画布安全构图", async () => {
  calls = [];
  const brief = { ...baseBrief, canvasPreset: "social-square" };
  const script = await generateScript(brief);
  const scenes = await generateStoryboard(brief, script);
  assert.ok(calls.some((c) => c.url.endsWith("/chat/completions")));
  assert.ok(Array.isArray(scenes) && scenes.length === 2);
  assert.equal(scenes[0].index, 1);
  assert.equal(scenes[0].camera, "push");
  assert.ok(scenes[0]._usage && scenes[0]._usage.tokens > 0);
  const storyboardCall = calls.find(
    (call) => call.url.endsWith("/chat/completions") && call.body.messages?.[0]?.content.includes("分镜师")
  );
  assert.match(storyboardCall.body.messages[1].content, /1080×1080/);
  assert.match(storyboardCall.body.messages[1].content, /1:1/);
  assert.match(storyboardCall.body.messages[1].content, /主体居中/);
  assert.match(storyboardCall.body.messages[1].content, /安全区/);
  assert.match(storyboardCall.body.messages[1].content, /恰好输出 2 个分镜|严格.*2.*分镜/);
  // response_format=json_object 强制顶层为对象，契约必须与解析层同为对象语义。
  assert.match(storyboardCall.body.messages[0].content, /scenes/);
  assert.match(storyboardCall.body.messages[0].content, /JSON 对象/);
});

test("generateStoryboard 数量不符只纠错重试一次，仍不符则失败", async () => {
  const script = await generateScript(baseBrief);
  calls = [];
  storyboardResponseCounts = [1, 2];
  const recovered = await generateStoryboard(baseBrief, script);
  const recoveredCalls = calls.filter((call) => call.url.endsWith("/chat/completions"));
  assert.equal(recoveredCalls.length, 2);
  assert.equal(recovered.length, 2);
  assert.match(recoveredCalls[1].body.messages[1].content, /纠正|上次|必须.*2/);

  calls = [];
  storyboardResponseCounts = [1, 1, 2];
  await assert.rejects(generateStoryboard(baseBrief, script), /分镜数量.*2|数量不一致/);
  assert.equal(calls.filter((call) => call.url.endsWith("/chat/completions")).length, 2, "最多一次纠错重试");
  storyboardResponseCounts = [];
});

test("generateStoryboard：兼容模型返回 {\"array\":[...]} 而非 scenes", async () => {
  // 实测 deepseek-v4-flash 在 response_format=json_object 下返回 {"array":[...]}；
  // 只认 parsed.scenes 会让整步误判为 0 个分镜并失败。
  const script = await generateScript(baseBrief);
  calls = [];
  storyboardWrapper = (scenes) => ({ array: scenes });
  try {
    const scenes = await generateStoryboard(baseBrief, script);
    assert.equal(scenes.length, 2);
    assert.equal(scenes[1].index, 2);
  } finally {
    storyboardWrapper = (scenes) => ({ scenes });
  }
});

test("generateStoryboard：兼容 storyboard 键与一层嵌套", async () => {
  const script = await generateScript(baseBrief);
  calls = [];
  storyboardWrapper = (scenes) => ({ storyboard: { items: scenes } });
  try {
    assert.equal((await generateStoryboard(baseBrief, script)).length, 2);
  } finally {
    storyboardWrapper = (scenes) => ({ scenes });
  }
});

test("generateStoryboard：musicClimax 为 0~1 情绪强度时按 ≥0.8 归一化", async () => {
  const script = await generateScript(baseBrief);
  calls = [];
  // 实测模型倾向返回情绪强度而非布尔值；若直接做 Boolean 转换会把每一镜都判成高潮。
  const intensity = [0.2, 1];
  storyboardWrapper = (scenes) => ({
    scenes: scenes.map((scene, i) => ({ ...scene, musicClimax: intensity[i] })),
  });
  try {
    const scenes = await generateStoryboard(baseBrief, script);
    assert.deepEqual(scenes.map((scene) => scene.musicClimax), [false, true]);
  } finally {
    storyboardWrapper = (scenes) => ({ scenes });
  }
});

test("generateStoryboard 纠错请求失败时保留首轮已付 tokens", async () => {
  const script = await generateScript(baseBrief);
  calls = [];
  storyboardCallIndex = 0;
  failStoryboardAt = 2;
  storyboardResponseCounts = [1];
  try {
    await assert.rejects(
      generateStoryboard(baseBrief, script),
      (error) => {
        assert.match(error.message, /500|retry failed/);
        assert.deepEqual(error._usage, { tokens: 200 });
        return true;
      },
    );
  } finally {
    failStoryboardAt = 0;
    storyboardResponseCounts = [];
  }
});

test("generateSceneMedia 真实模式：POST /images/generations + 返回 url + _usage.images", async () => {
  calls = [];
  const script = await generateScript(baseBrief);
  const scenes = await generateStoryboard(baseBrief, script);
  const media = await generateSceneMedia(scenes[0], baseBrief);
  assert.match(calls[calls.length - 1].url, /\/images\/generations$/);
  assert.equal(calls[calls.length - 1].body.model, "doubao-seedream-4-0-250828");
  // Seedream 使用分辨率档位 + 画布比例；未指定画布时默认竖屏。
  assert.equal(calls[calls.length - 1].body.size, "1K");
  assert.equal(calls[calls.length - 1].body.aspect_ratio, "9:16");
  assert.match(calls[calls.length - 1].body.prompt, /1080×1920/);
  assert.match(calls[calls.length - 1].body.prompt, /主体居中/);
  assert.equal(media.mediaUrl, "https://cdn.example/scene.png");
  assert.equal(media._usage.images, 1);
});

test("generateSceneMedia 普通图像模型：使用所选画布的像素尺寸", async () => {
  calls = [];
  await generateSceneMedia(
    { visualPrompt: "产品主视觉" },
    { ...baseBrief, imageModel: "gpt-image-1", canvasPreset: "social-landscape" }
  );
  const imageCall = calls.find((call) => call.url.endsWith("/images/generations"));
  assert.equal(imageCall.body.size, "1920x1080");
  assert.equal(imageCall.body.aspect_ratio, undefined);
  assert.match(imageCall.body.prompt, /1920×1080/);
  assert.match(imageCall.body.prompt, /16:9/);
  assert.match(imageCall.body.prompt, /安全区/);
});

test("generateSceneMedia 参考图为 data:image → 走图生图（image 字段 base64）", async () => {
  calls = [];
  const script = await generateScript(baseBrief);
  const scenes = await generateStoryboard(baseBrief, script);
  const media = await generateSceneMedia(scenes[0], { ...baseBrief, styleReference: "data:image/png;base64,iVBORw0KGgo=" });
  const last = calls[calls.length - 1];
  assert.match(last.url, /\/images\/generations$/);
  assert.ok(last.body.image, "应携带 image 参考图字段");
  assert.equal(last.body.image, "iVBORw0KGgo="); // 去 data: 前缀，留 base64
  assert.equal(media._usage.images, 1);
});

test("generateSceneMedia 参考图为 http(s) URL → 走图生图（image 字段为 URL）", async () => {
  calls = [];
  const script = await generateScript(baseBrief);
  const scenes = await generateStoryboard(baseBrief, script);
  const media = await generateSceneMedia(scenes[0], { ...baseBrief, styleReference: "https://cdn.example/ref.png" });
  assert.equal(calls[calls.length - 1].body.image, "https://cdn.example/ref.png");
  assert.equal(media._usage.images, 1);
});

test("generateSceneMedia 参考图为纯关键词 → 追加到 prompt（M2 行为，向后兼容）", async () => {
  calls = [];
  const script = await generateScript(baseBrief);
  const scenes = await generateStoryboard(baseBrief, script);
  const media = await generateSceneMedia(scenes[0], { ...baseBrief, styleReference: "赛博朋克" });
  assert.equal(calls[calls.length - 1].body.image, undefined, "关键词不应走 image 字段");
  assert.match(calls[calls.length - 1].body.prompt, /赛博朋克/, "关键词应拼入 prompt");
});

test("generateVoiceover 真实模式：每句调用 TTS、物化探测、拼接并聚合真实用量", async () => {
  calls = [];
  speechResponses = [makeWav(1.4, 440), makeWav(2.1, 660)];
  const script = { voiceover: [
    { timecode: "错误时间", text: "第一句" },
    { timecode: "99:99:99.999", text: "第二句" },
  ] };
  const v = await generateVoiceover(script, { ...baseBrief, ttsModel: "speech-02-hd" }, { workspace: audioWorkspace() });
  const ttsCalls = calls.filter((call) => call.url.endsWith("/audio/speech"));
  assert.equal(ttsCalls.length, 2);
  assert.deepEqual(ttsCalls.map((call) => call.body.input), ["第一句", "第二句"]);
  assert.ok(ttsCalls.every((call) => call.body.model === "speech-02-hd"));
  assert.ok(ttsCalls.every((call) => call.body.voice === "onyx"));
  assert.ok(ttsCalls.every((call) => call.body.response_format === undefined), "非 OpenAI 原生 TTS 不应带 response_format");
  assert.ok(fs.existsSync(v.voicePath));
  assert.deepEqual(v.sceneDurationsMs, [1520, 2100]);
  assert.equal(v.durationSec, 3.62);
  assert.match(v.srt, /00:00:01,520 --> 00:00:03,620/);
  assert.equal(v.model, "speech-02-hd");
  assert.equal(v._usage.requests, 2);
  assert.ok(Math.abs(v._usage.minutes - 3.5 / 60) < 0.001);
});

test("generateVoiceover 真实模式：TTS 请求体携带 language（多语言 FR-12）", async () => {
  calls = [];
  const script = await generateScript({ ...baseBrief, language: "en" });
  const v = await generateVoiceover(script, { ...baseBrief, language: "en" }, { workspace: audioWorkspace() });
  const last = calls[calls.length - 1];
  assert.match(last.url, /\/audio\/speech$/);
  assert.equal(last.body.language, "en");
  assert.ok(fs.existsSync(v.voicePath));
});

test("generateVoiceover OpenAI TTS 才携带 response_format，空文本与空响应失败", async () => {
  calls = [];
  await generateVoiceover(
    { voiceover: [{ text: "OpenAI" }] },
    { ...baseBrief, ttsModel: "tts-1-hd" },
    { workspace: audioWorkspace() },
  );
  assert.equal(calls.find((call) => call.url.endsWith("/audio/speech")).body.response_format, "mp3");
  calls = [];
  await generateVoiceover(
    { voiceover: [{ text: "非 OpenAI 名称" }] },
    { ...baseBrief, ttsModel: "proxy-gpt-4o-mini-tts-clone" },
    { workspace: audioWorkspace() },
  );
  assert.equal(calls.find((call) => call.url.endsWith("/audio/speech")).body.response_format, undefined);
  await assert.rejects(
    generateVoiceover({ voiceover: [{ text: "" }] }, baseBrief, { workspace: audioWorkspace() }),
    /空|文本/,
  );
  speechResponses = [Buffer.alloc(0)];
  await assert.rejects(
    generateVoiceover({ voiceover: [{ text: "有文本" }] }, baseBrief, { workspace: audioWorkspace() }),
    /空|音频|媒体/,
  );
});

test("逐句 TTS 第 N 次失败时异常保留此前已付费用量", async () => {
  speechCallIndex = 0;
  failSpeechAt = 2;
  try {
    await assert.rejects(
      generateVoiceover(
        { voiceover: [{ text: "已成功" }, { text: "此句失败" }, { text: "不会调用" }] },
        baseBrief,
        { workspace: audioWorkspace() },
      ),
      (error) => {
        assert.match(error.message, /500|failed/);
        assert.equal(error._usage.requests, 1);
        assert.ok(error._usage.minutes > 0);
        return true;
      },
    );
  } finally {
    failSpeechAt = 0;
  }
});

test("generateVoiceover：主通道 403 时自动切换到 Omni 流式备用通道", async () => {
  calls = [];
  speechCallIndex = 0;
  failSpeechAt = 1; // 上游 apilio 渠道额度为负时 /audio/speech 返回 403，这里用首句失败模拟同一分支。
  const fallbackModel = "qwen3.5-omni-flash-2026-03-15";
  try {
    const script = { voiceover: [{ text: "第一句" }, { text: "第二句" }] };
    const v = await generateVoiceover(
      script,
      { ...baseBrief, ttsModel: "speech-02-hd", ttsFallbackModel: fallbackModel },
      { workspace: audioWorkspace() },
    );
    const omniCalls = calls.filter((call) => call.url.endsWith("/chat/completions") && call.body.modalities?.includes("audio"));
    assert.equal(omniCalls.length, 2, "切换后应固定走备用通道，避免同一支成片中途换音色");
    assert.ok(omniCalls.every((call) => call.body.model === fallbackModel));
    assert.ok(omniCalls.every((call) => call.body.stream === true), "Omni 语音只支持流式返回");
    assert.deepEqual(omniCalls.map((call) => call.body.audio), [
      { voice: "Ethan", format: "pcm" },
      { voice: "Ethan", format: "pcm" },
    ]);
    assert.deepEqual(omniCalls.map((call) => call.body.messages[1].content), ["第一句", "第二句"]);
    assert.equal(v.model, fallbackModel, "审计字段必须记录实际使用的备用模型");
    assert.match(v.fallbackNote, /speech-02-hd/);
    assert.match(v.fallbackNote, new RegExp(fallbackModel));
    assert.equal(v._usage.requests, 2);
    assert.ok(fs.existsSync(v.voicePath));
    assert.match(v.srt, /第一句/);
  } finally {
    failSpeechAt = 0;
  }
});

test("generateVoiceover：主/备两条通道都失败时错误同时给出两个模型", async () => {
  calls = [];
  speechCallIndex = 0;
  failSpeechAt = 1;
  omniFailStatus = 403;
  omniFailText = "insufficient_user_quota";
  try {
    await assert.rejects(
      generateVoiceover(
        { voiceover: [{ text: "无法合成" }] },
        { ...baseBrief, ttsModel: "speech-02-hd", ttsFallbackModel: "qwen3.5-omni-flash-2026-03-15" },
        { workspace: audioWorkspace() },
      ),
      (error) => {
        assert.match(error.message, /两条通道均失败/);
        assert.match(error.message, /speech-02-hd/);
        assert.match(error.message, /qwen3.5-omni-flash-2026-03-15/);
        assert.match(error.message, /insufficient_user_quota/);
        return true;
      },
    );
  } finally {
    failSpeechAt = 0;
    omniFailStatus = 0;
    omniFailText = "omni failed";
  }
});

test("generateVoiceover：未配置备用模型时保持主通道硬失败语义", async () => {
  calls = [];
  speechCallIndex = 0;
  failSpeechAt = 1;
  try {
    await assert.rejects(
      generateVoiceover(
        { voiceover: [{ text: "无备用" }] },
        { ...baseBrief, ttsModel: "speech-02-hd", ttsFallbackModel: null },
        { workspace: audioWorkspace() },
      ),
      /500|failed/,
    );
    assert.equal(calls.filter((call) => call.body.modalities?.includes("audio")).length, 0, "无备用模型时不得偷偷打 Omni");
  } finally {
    failSpeechAt = 0;
  }
});

test("TTS 与配乐付费响应在物化失败时把部分用量附到异常", async () => {
  speechCallIndex = 0;
  speechResponses = [Buffer.from("invalid audio")];
  await assert.rejects(
    generateVoiceover({ voiceover: [{ text: "已付费但坏音频" }] }, baseBrief, { workspace: audioWorkspace() }),
    (error) => {
      assert.equal(error._usage.requests, 1);
      assert.ok(error._usage.minutes > 0);
      return true;
    },
  );

  invalidMusicResponse = true;
  try {
    await assert.rejects(
      generateMusic(baseBrief, [], { workspace: audioWorkspace() }),
      (error) => {
        assert.equal(error._usage.tracks, 1);
        return true;
      },
    );
  } finally {
    invalidMusicResponse = false;
  }
});

test("generateStoryboard 真实模式：prompt 注入全局语言（en → Output in English）", async () => {
  calls = [];
  const script = await generateScript({ ...baseBrief, language: "en" });
  await generateStoryboard({ ...baseBrief, language: "en" }, script);
  const sb = calls.find((c) => c.url.endsWith("/chat/completions") && (c.body.messages?.[0]?.content || "").includes("分镜师"));
  assert.ok(sb, "应调用分镜 chat");
  assert.match(sb.body.messages[1].content, /Output in English\./);
});

test("generateScript 真实模式：bannedWords 注入 prompt（M4 模板库约束）", async () => {
  calls = [];
  const out = await generateScript({ ...baseBrief, bannedWords: ["最", "第一"] });
  const user = calls[0].body.messages[1].content;
  assert.match(user, /禁用词：最、第一/);
  assert.equal(out.language, "zh-CN");
});

test("generateStoryboard / generateSceneMedia 真实模式：logoColor 注入品牌主色（M4 模板库约束）", async () => {
  // F1 闭环的后端半环：前端表单或模板套用提交 logoColor 后，须真正注入分镜与图像 prompt。
  // 修复前前端从不提交该字段，导致这两个分支恒不触发（品牌主色能力对终端用户不存在）。
  const brief = { ...baseBrief, logoColor: "#0ea5e9" };

  calls = [];
  const script = await generateScript(brief);
  const scenes = await generateStoryboard(brief, script);
  const sb = calls.find(
    (c) => c.url.endsWith("/chat/completions") && (c.body.messages?.[0]?.content || "").includes("分镜师")
  );
  assert.ok(sb, "应调用分镜 chat");
  assert.match(sb.body.messages[1].content, /品牌主色 #0ea5e9/, "分镜 prompt 应含品牌主色");

  calls = [];
  await generateSceneMedia(scenes[0], brief);
  const img = calls.find((c) => c.url.endsWith("/images/generations"));
  assert.ok(img, "应调用图像生成");
  assert.match(img.body.prompt, /主色 #0ea5e9/, "图像 prompt 应含品牌主色");
});

test("真实模式：Brief.llmModel / Brief.imageModel 请求级覆盖模型（模型可见可选）", async () => {
  calls = [];
  await generateScript({ ...baseBrief, llmModel: "glm-5" });
  assert.equal(calls[0].body.model, "glm-5", "脚本请求应用 brief.llmModel 覆盖 env 默认");

  const script = await generateScript({ ...baseBrief, llmModel: "glm-5" });
  assert.equal(script.model, "glm-5", "返回值应带实际使用的模型名（前端展示用）");

  calls = [];
  await generateSceneMedia({ visualPrompt: "城市航拍" }, { ...baseBrief, imageModel: "doubao-seedream-3-0-t2i" });
  const img = calls.find((c) => c.url.endsWith("/images/generations"));
  assert.equal(img.body.model, "doubao-seedream-3-0-t2i", "图像请求应用 brief.imageModel 覆盖");

  // 不传时回落 env 默认
  calls = [];
  const def = await generateScript(baseBrief);
  assert.equal(calls[0].body.model, process.env.PROMO_LLM_MODEL || "deepseek-v4-flash");
  assert.equal(def.model, process.env.PROMO_LLM_MODEL || "deepseek-v4-flash");
});

test("generateMusic 真实模式：Mureka 桥提交 + 轮询 + 物化 + _usage.tracks", async () => {
  calls = [];
  const script = await generateScript(baseBrief);
  const scenes = await generateStoryboard(baseBrief, script);
  const m = await generateMusic({ ...baseBrief, musicModel: "mureka-song" }, scenes, { workspace: audioWorkspace() });
  const submit = calls.find((c) => c.url.endsWith("/chat/completions") && c.body.model === "mureka-song");
  assert.ok(submit, "配乐必须先经 mureka-song 提交任务");
  const submitted = JSON.parse(submit.body.messages[0].content);
  assert.match(submitted.prompt, /背景音乐/);
  assert.equal(submitted.mode, "instrumental");
  const poll = calls.find((c) => c.url.endsWith("/chat/completions") && c.body.model === "mureka-query");
  assert.ok(poll, "配乐必须经 mureka-query 轮询结果");
  assert.deepEqual(JSON.parse(poll.body.messages[0].content), { taskId: "t1", kind: "instrumental" });
  assert.ok(fs.existsSync(m.musicPath));
  assert.ok(m.durationSec > 0.9);
  assert.equal(m._usage.tracks, 1);

test("generateMusic：提交遇 bridge_upstream_unavailable（连接未到达上游）时重试一次并成功", async () => {
  // 说明：2026-09 真实验收在 voiceover 成功后、generateScenes 之前被一次 502 UND_ERR_SOCKET 打断；
  // 桥已声明该故障发生在到达上游之前，重发安全，重试把一次性抖动挡在付费视频阶段之外。
  calls = [];
  process.env.PROMO_MUSIC_RETRY_BACKOFF_MS = "5";
  murekaSubmitFailures = 1;
  try {
    const scenes = await generateStoryboard(baseBrief, await generateScript(baseBrief));
    const m = await generateMusic(baseBrief, scenes, { workspace: audioWorkspace() });
    const submissions = calls.filter((c) => c.url.endsWith("/chat/completions") && c.body.model === "mureka-song").length;
    assert.equal(submissions, 2, "瞬时故障应重试提交，共 2 次提交调用");
    assert.ok(fs.existsSync(m.musicPath));
  } finally {
    murekaSubmitFailures = 0;
    delete process.env.PROMO_MUSIC_RETRY_BACKOFF_MS;
  }
});

test("generateMusic：轮询遇瞬时故障只重试查询，绝不重新提交已付费任务", async () => {
  calls = [];
  process.env.PROMO_MUSIC_RETRY_BACKOFF_MS = "5";
  murekaQueryFailures = 1;
  try {
    const scenes = await generateStoryboard(baseBrief, await generateScript(baseBrief));
    const m = await generateMusic(baseBrief, scenes, { workspace: audioWorkspace() });
    const submissions = calls.filter((c) => c.url.endsWith("/chat/completions") && c.body.model === "mureka-song").length;
    const queries = calls.filter((c) => c.url.endsWith("/chat/completions") && c.body.model === "mureka-query").length;
    assert.equal(submissions, 1, "轮询抖动不得触发第二次提交付费任务");
    assert.equal(queries, 2, "轮询应重试一次后拿到结果");
    assert.ok(fs.existsSync(m.musicPath));
  } finally {
    murekaQueryFailures = 0;
    delete process.env.PROMO_MUSIC_RETRY_BACKOFF_MS;
  }
});

test("generateMusic：契约类 4xx 立即失败，不做无意义重试", async () => {
  calls = [];
  process.env.PROMO_MUSIC_RETRY_BACKOFF_MS = "5";
  murekaSubmitFailures = 5;
  murekaFailureStatus = 400;
  murekaFailureCode = "bridge_upstream_error";
  murekaFailureMessage = "Mureka 拒绝请求：prompt 非法";
  try {
    await assert.rejects(generateMusic(baseBrief, [], { workspace: audioWorkspace() }), /400/);
    const submissions = calls.filter((c) => c.url.endsWith("/chat/completions") && c.body.model === "mureka-song").length;
    assert.equal(submissions, 1, "4xx 契约类错误只应尝试一次");
  } finally {
    murekaSubmitFailures = 0;
    murekaFailureStatus = 502;
    murekaFailureCode = "bridge_upstream_unavailable";
    murekaFailureMessage = "Mureka 上游网络暂时不可用（UND_ERR_SOCKET）";
    delete process.env.PROMO_MUSIC_RETRY_BACKOFF_MS;
  }
});

test("generateMusic：提交受理结果未知（bridge_submission_unknown）时不得重试，避免重复付费生成", async () => {
  calls = [];
  process.env.PROMO_MUSIC_RETRY_BACKOFF_MS = "5";
  murekaSubmitFailures = 5;
  murekaFailureCode = "bridge_submission_unknown";
  murekaFailureMessage = "Mureka 提交连接中断，受理结果未知（UND_ERR_SOCKET）";
  try {
    await assert.rejects(generateMusic(baseBrief, [], { workspace: audioWorkspace() }));
    const submissions = calls.filter((c) => c.url.endsWith("/chat/completions") && c.body.model === "mureka-song").length;
    assert.equal(submissions, 1, "受理结果未知时重发可能生成两首，必须只提交一次");
  } finally {
    murekaSubmitFailures = 0;
    murekaFailureCode = "bridge_upstream_unavailable";
    murekaFailureMessage = "Mureka 上游网络暂时不可用（UND_ERR_SOCKET）";
    delete process.env.PROMO_MUSIC_RETRY_BACKOFF_MS;
  }
});
});

test("composite 真实模式缺少受管产物目录或 FFmpeg：直接拒绝，不再降级为分镜包", async () => {
  const script = await generateScript(baseBrief);
  const scenes = await generateStoryboard(baseBrief, script);
  const v = await generateVoiceover(script, baseBrief, { workspace: audioWorkspace() });
  const m = await generateMusic(baseBrief, scenes, { workspace: audioWorkspace() });
  const probeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "promo-provider-reject-"));
  const previousOutputRoot = process.env.PROMO_OUTPUT_ROOT;
  process.env.PROMO_OUTPUT_ROOT = probeRoot;
  try {
    // 缺少受管产物目录：必须直接失败，不得回落为分镜包
    await assert.rejects(() => composite(scenes, v, m, baseBrief), /受管产物目录|artifactPaths/u);
    const paths = artifactPaths("provider-composite-reject");
    const previousFfmpeg = process.env.PROMO_FFMPEG_BIN;
    delete process.env.PROMO_FFMPEG_BIN;
    try {
      await assert.rejects(
        () => composite(scenes, v, m, baseBrief, { paths }),
        /PROMO_FFMPEG_BIN/u,
      );
    } finally {
      if (previousFfmpeg === undefined) delete process.env.PROMO_FFMPEG_BIN;
      else process.env.PROMO_FFMPEG_BIN = previousFfmpeg;
    }
    assert.equal(fs.existsSync(paths.finalVideo), false, "拒绝路径不得遗留 final.mp4");
    assert.equal(fs.existsSync(paths.manifest), false, "拒绝路径不得遗留 manifest.json");
  } finally {
    if (previousOutputRoot === undefined) delete process.env.PROMO_OUTPUT_ROOT;
    else process.env.PROMO_OUTPUT_ROOT = previousOutputRoot;
    fs.rmSync(probeRoot, { recursive: true, force: true });
  }
});

test("provider 产出的受管配音与配乐进入真实合成并烧录字幕", async () => {
  const previousFfmpeg = process.env.PROMO_FFMPEG_BIN;
  const previousOutputRoot = process.env.PROMO_OUTPUT_ROOT;
  const probeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "promo-provider-mix-"));
  process.env.PROMO_FFMPEG_BIN = "ffmpeg";
  process.env.PROMO_OUTPUT_ROOT = probeRoot;
  try {
    const brief = { ...baseBrief, canvasPreset: "social-portrait" };
    const scripted = await generateScript(brief);
    // 字幕像素校验要求真实字形覆盖：mock 脚本返回的拉丁短语覆盖不足，改用真实中文台词。
    const script = {
      ...scripted,
      voiceover: [
        { timecode: "00:00:00.000", text: "铭星科技开场" },
        { timecode: "00:00:01.000", text: "真实成片交付" },
      ],
    };
    const proposed = await generateStoryboard(brief, script);
    const paths = artifactPaths("provider-composite-mix");
    const voice = await generateVoiceover(script, brief, { workspace: paths.audio });
    const music = await generateMusic(brief, proposed, { workspace: paths.audio });

    // 真实合成只消费受管工作区内的标准化动态片段：逐镜按权威时长归一化。
    const scenes = [];
    for (let index = 0; index < proposed.length; index += 1) {
      const durationSec = voice.sceneDurationsMs[index] / 1000;
      const rawClip = path.join(paths.inputs, "raw-" + (index + 1) + ".mp4");
      execFileSync("ffmpeg", [
        "-y", "-v", "error", "-f", "lavfi",
        "-i", "color=c=0x1" + index + "1" + index + "1" + index + ":s=640x360:d=" + durationSec + ":r=24",
        "-an", "-c:v", "libx264", "-pix_fmt", "yuv420p", rawClip,
      ], { stdio: "pipe" });
      const videoPath = await normalizeSceneVideo({
        source: rawClip,
        inputsWorkspace: paths.inputs,
        scenesWorkspace: paths.scenes,
        canvasPreset: brief.canvasPreset,
        durationSec,
      });
      scenes.push({ ...proposed[index], videoPath, durationSec });
    }

    const out = await composite(scenes, voice, music, brief, { paths });
    assert.equal(out.model, "ffmpeg", out.note);
    assert.equal(out.validated, true, "真实合成必须标记为已校验");
    const outputFile = fileURLToPath(out.videoUrl);
    assert.equal(outputFile, paths.finalVideo);
    assert.equal(fs.realpathSync(path.dirname(outputFile)), fs.realpathSync(paths.runRoot));
    assert.ok(fs.existsSync(paths.subtitles) && fs.existsSync(paths.manifest));
    const streams = execFileSync("ffprobe", [
      "-v", "error", "-show_entries", "stream=codec_type,codec_name,width,height:format=duration,format_name",
      "-of", "json", outputFile,
    ], { stdio: "pipe" }).toString();
    const probed = JSON.parse(streams);
    const video = probed.streams.find((s) => s.codec_type === "video");
    const audio = probed.streams.find((s) => s.codec_type === "audio");
    assert.equal(video.codec_name, "h264");
    assert.equal(Number(video.width), 1080);
    assert.equal(Number(video.height), 1920);
    assert.equal(audio.codec_name, "aac");
    assert.match(String(probed.format.format_name), /mp4/u);
    assert.ok(Math.abs(Number(probed.format.duration) - voice.durationSec) <= 0.75);
    assert.ok(fs.readFileSync(paths.subtitles, "utf8").includes("铭星科技开场"), "硬字幕来源 SRT 应保留逐句台词");
  } finally {
    if (previousFfmpeg === undefined) delete process.env.PROMO_FFMPEG_BIN;
    else process.env.PROMO_FFMPEG_BIN = previousFfmpeg;
    if (previousOutputRoot === undefined) delete process.env.PROMO_OUTPUT_ROOT;
    else process.env.PROMO_OUTPUT_ROOT = previousOutputRoot;
    fs.rmSync(probeRoot, { recursive: true, force: true });
  }
});

test("one-api 未配置时真实 Provider 抛错（缺 base/key）", async () => {
  const prevBase = process.env.PROMO_ONEAPI_BASE_URL;
  const prevKey = process.env.PROMO_ONEAPI_API_KEY;
  delete process.env.PROMO_ONEAPI_BASE_URL;
  delete process.env.PROMO_ONEAPI_API_KEY;
  await assert.rejects(() => generateScript(baseBrief), /one-api 未配置/);
  process.env.PROMO_ONEAPI_BASE_URL = prevBase;
  process.env.PROMO_ONEAPI_API_KEY = prevKey;
});
