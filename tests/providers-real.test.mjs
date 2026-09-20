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
process.env.PROMO_MUSIC_MODEL = "mureka-v1";
process.env.PROMO_MUSIC_PATH = "/audio/music";

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { artifactPaths } from "../src/media/artifacts.js";

const { test, after } = await import("node:test");
const assert = (await import("node:assert/strict")).default;
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
let failSpeechAt = 0;
let speechCallIndex = 0;
let invalidMusicResponse = false;
after(() => fs.rmSync(mediaRoot, { recursive: true, force: true }));

// ── fetch mock 基础设施 ──
let calls = [];
function makeRes({ ok = true, status = 200, json, text, bytes } = {}) {
  const res = {
    ok,
    status,
    json: async () => json,
    text: async () => text ?? "",
    arrayBuffer: async () => (bytes ? Buffer.from(bytes) : Buffer.alloc(0)),
  };
  return res;
}
function route(path, body) {
  // 依据 path 与 body 返回对应 one-api 形状响应。
  if (path.endsWith("/chat/completions")) {
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
      const sceneCount = storyboardResponseCounts.length ? storyboardResponseCounts.shift() : 2;
      return makeRes({
        json: {
          choices: [{ message: { content: JSON.stringify({
            scenes: Array.from({ length: sceneCount }, (_, index) => ({
              index: index + 1,
              visualPrompt: `p${index + 1}`,
              subtitle: `s${index + 1}`,
              camera: index % 2 ? "pull" : "push",
              durationSec: 5,
              musicClimax: index === sceneCount - 1,
            })),
          }) } }],
          usage: { total_tokens: 200 },
        },
      });
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
  if (path.endsWith("/audio/music")) {
    if (invalidMusicResponse) return makeRes({ json: { data: [{ b64_json: Buffer.from("invalid").toString("base64") }] } });
    return makeRes({ json: { data: [{ b64_json: DEFAULT_MUSIC.toString("base64") }] } });
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

test("generateMusic 真实模式：POST /audio/music + 返回 url + _usage.tracks", async () => {
  calls = [];
  const script = await generateScript(baseBrief);
  const scenes = await generateStoryboard(baseBrief, script);
  const m = await generateMusic({ ...baseBrief, musicModel: "mureka-v1" }, scenes, { workspace: audioWorkspace() });
  assert.match(calls[calls.length - 1].url, /\/audio\/music$/);
  assert.equal(calls[calls.length - 1].body.model, "mureka-v1");
  assert.ok(fs.existsSync(m.musicPath));
  assert.ok(m.durationSec > 0.9);
  assert.equal(m._usage.tracks, 1);
});

test("composite 真实模式无 FFmpeg：优雅降级为分镜包（含 reason）", async () => {
  delete process.env.PROMO_FFMPEG_BIN;
  const script = await generateScript(baseBrief);
  const scenes = await generateStoryboard(baseBrief, script);
  const v = await generateVoiceover(script, baseBrief, { workspace: audioWorkspace() });
  const m = await generateMusic(baseBrief, scenes, { workspace: audioWorkspace() });
  const comp = await composite(scenes, v, m, baseBrief);
  assert.equal(comp.model, "demo-composite");
  assert.match(comp.note, /未配置 PROMO_FFMPEG_BIN/);
  assert.ok(Array.isArray(comp.storyboardGallery) && comp.storyboardGallery.length === 2);
});

test("provider 产出的 file:// 配音与配乐进入现有 compositor 音频流", async () => {
  const previousFfmpeg = process.env.PROMO_FFMPEG_BIN;
  process.env.PROMO_FFMPEG_BIN = "ffmpeg";
  const pngFile = path.join(mediaRoot, "provider-composite.png");
  execFileSync("ffmpeg", ["-y", "-f", "lavfi", "-i", "color=c=blue:s=320x180", "-frames:v", "1", pngFile], { stdio: "pipe" });
  const scenes = [{
    index: 1,
    subtitle: "真实音频",
    mediaUrl: `data:image/png;base64,${fs.readFileSync(pngFile).toString("base64")}`,
    durationSec: 1,
  }];
  try {
    const audioDir = audioWorkspace();
    const voice = await generateVoiceover({ voiceover: [{ text: "真实音频" }] }, baseBrief, { workspace: audioDir });
    const music = await generateMusic(baseBrief, scenes, { workspace: audioDir });
    const out = await composite(scenes, voice, music, baseBrief);
    assert.equal(out.model, "ffmpeg", out.note);
    const outputFile = fileURLToPath(out.videoUrl);
    const stream = execFileSync("ffprobe", [
      "-v", "error", "-select_streams", "a:0", "-show_entries", "stream=codec_type", "-of", "csv=p=0", outputFile,
    ], { stdio: "pipe" }).toString().trim();
    assert.equal(stream, "audio");
  } finally {
    if (previousFfmpeg === undefined) delete process.env.PROMO_FFMPEG_BIN;
    else process.env.PROMO_FFMPEG_BIN = previousFfmpeg;
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
