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

const { test } = await import("node:test");
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
              title: "T", voiceover: [{ timecode: "00:00:00.000", text: "hi" }],
              structure: ["a"], moodCurve: ["x"],
            }) } }],
            usage: { total_tokens: 120 },
          },
        });
      }
      // 分镜
      return makeRes({
        json: {
          choices: [{ message: { content: JSON.stringify({
            scenes: [
              { index: 1, visualPrompt: "p1", subtitle: "s1", camera: "push", durationSec: 5, musicClimax: false },
              { index: 2, visualPrompt: "p2", subtitle: "s2", camera: "pull", durationSec: 5, musicClimax: true },
            ],
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
    return makeRes({ bytes: [0x49, 0x44, 0x33, 0x03] }); // 伪造 mp3 字节
  }
  if (path.endsWith("/audio/music")) {
    return makeRes({ json: { data: [{ url: "https://cdn.example/bgm.mp3" }] } });
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
test("getProviderMode 默认（未设置）返回 demo（独立断言，临时改环境）", () => {
  const prev = process.env.PROMO_PROVIDER_MODE;
  delete process.env.PROMO_PROVIDER_MODE;
  assert.equal(getProviderMode(), "demo");
  process.env.PROMO_PROVIDER_MODE = prev;
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

test("generateStoryboard 真实模式：返回 Scene[] 且每镜带 _usage.tokens", async () => {
  calls = [];
  const script = await generateScript(baseBrief);
  const scenes = await generateStoryboard(baseBrief, script);
  assert.ok(calls.some((c) => c.url.endsWith("/chat/completions")));
  assert.ok(Array.isArray(scenes) && scenes.length === 2);
  assert.equal(scenes[0].index, 1);
  assert.equal(scenes[0].camera, "push");
  assert.ok(scenes[0]._usage && scenes[0]._usage.tokens > 0);
});

test("generateSceneMedia 真实模式：POST /images/generations + 返回 url + _usage.images", async () => {
  calls = [];
  const script = await generateScript(baseBrief);
  const scenes = await generateStoryboard(baseBrief, script);
  const media = await generateSceneMedia(scenes[0], baseBrief);
  assert.match(calls[calls.length - 1].url, /\/images\/generations$/);
  assert.equal(calls[calls.length - 1].body.model, "doubao-seedream-4-0-250828");
  // 渠道适配：doubao/seedream 系 size 用词汇 1K|2K|4K（像素写法会 400）+ 16:9 画幅
  assert.equal(calls[calls.length - 1].body.size, "1K");
  assert.equal(calls[calls.length - 1].body.aspect_ratio, "16:9");
  assert.equal(media.mediaUrl, "https://cdn.example/scene.png");
  assert.equal(media._usage.images, 1);
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

test("generateVoiceover 真实模式：POST /audio/speech 二进制 + data URI + _usage.minutes", async () => {
  calls = [];
  const script = await generateScript(baseBrief);
  const v = await generateVoiceover(script, baseBrief);
  assert.match(calls[calls.length - 1].url, /\/audio\/speech$/);
  assert.equal(calls[calls.length - 1].body.voice, "male"); // 男声 → male
  assert.match(v.voiceUrl, /^data:audio\/mp3;base64,/);
  assert.ok(v.srt.includes("-->"));
  assert.ok(v._usage.minutes > 0);
});

test("generateVoiceover 真实模式：TTS 请求体携带 language（多语言 FR-12）", async () => {
  calls = [];
  const script = await generateScript({ ...baseBrief, language: "en" });
  const v = await generateVoiceover(script, { ...baseBrief, language: "en" });
  const last = calls[calls.length - 1];
  assert.match(last.url, /\/audio\/speech$/);
  assert.equal(last.body.language, "en");
  assert.match(v.voiceUrl, /^data:audio\/mp3;base64,/);
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
  const m = await generateMusic(baseBrief, scenes);
  assert.match(calls[calls.length - 1].url, /\/audio\/music$/);
  assert.equal(calls[calls.length - 1].body.model, "mureka-v1");
  assert.equal(m.musicUrl, "https://cdn.example/bgm.mp3");
  assert.equal(m._usage.tracks, 1);
});

test("composite 真实模式无 FFmpeg：优雅降级为分镜包（含 reason）", async () => {
  delete process.env.PROMO_FFMPEG_BIN;
  const script = await generateScript(baseBrief);
  const scenes = await generateStoryboard(baseBrief, script);
  const v = await generateVoiceover(script, baseBrief);
  const m = await generateMusic(baseBrief, scenes);
  const comp = await composite(scenes, v, m, baseBrief);
  assert.equal(comp.model, "demo-composite");
  assert.match(comp.note, /未配置 PROMO_FFMPEG_BIN/);
  assert.ok(Array.isArray(comp.storyboardGallery) && comp.storyboardGallery.length === 2);
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
