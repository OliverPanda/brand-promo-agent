// Provider 抽象层：所有外部能力（LLM / 图像 / TTS / 音乐 / 动态视频 / 合成）均经此适配。
// 默认 DEMO 模式：完全离线、确定性的占位生成，无需任何外部密钥即可端到端运行。
// 生产模式（PROMO_PROVIDER_MODE=real）：经 one-api（OpenAI 兼容统一网关）调用真实能力，
//   图像走 /v1/images/generations（Seedream 等），TTS 走 /v1/audio/speech，音乐走 Mureka 桥，
//   动态视频走 /v1/videos/generations（图生/文生，异步任务轮询，PROMO_VIDEO_TIMEOUT_MS 超时）；
//   合成走服务端 FFmpeg（PROMO_FFMPEG_BIN）。每个真实能力回传 _usage 供成本归集。
//
// 切换只需设置环境变量，【工作流代码不变】。本文件不含网络调用时机之外的业务逻辑。

import { encodeSVG } from "./svg.js";
import { withGlobalLanguage } from "../i18n.js";
import { getEffectiveOneApiBase, getEffectiveProviderMode, getEffectiveOneApiKey } from "../runtime-config.js";

// ───────────────────────── 模式判定 ─────────────────────────
// 生效顺序：运行时配置（页面「模型与服务」保存的 providerMode）> env（PROMO_PROVIDER_MODE=real）；
// 其余一律 DEMO（安全默认，零外部依赖）。页面保存 real 即立即生效、无需重启。
export function getProviderMode() {
  return getEffectiveProviderMode();
}

// 当前生效的网关密钥（页面保存的 apiKey 优先，回退 env）。
function activeKey() {
  return getEffectiveOneApiKey();
}

// ───────────────────────── 工具：确定性随机（按 brief 稳定） ─────────────────────────
function hashSeed(str = "") {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
function mulberry32(a) {
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ───────────────────────── 调性 → 配色 ─────────────────────────
const TONE_PALETTE = {
  科技感: ["#0ea5e9", "#1e3a8a"],
  温情: ["#f59e0b", "#ef4444"],
  高端: ["#111827", "#6b7280"],
  国潮: ["#dc2626", "#facc15"],
  搞笑: ["#22c55e", "#84cc16"],
  专业: ["#1d4ed8", "#0f172a"],
};
function paletteFor(tones = []) {
  for (const t of tones) if (TONE_PALETTE[t]) return TONE_PALETTE[t];
  return ["#6366f1", "#0ea5e9"];
}

// ───────────────────────── one-api HTTP 客户端（OpenAI 兼容） ─────────────────────────
async function oneApiPost(path, body, { isBinary = false, timeoutMs = 120000 } = {}) {
  // base/key = 运行时配置覆盖（前端「模型与服务」保存的供应商地址与密钥）> env 默认；每次调用现取，改完即生效。
  const base = getEffectiveOneApiBase();
  const key = activeKey();
  if (!base || !key) throw new Error("one-api 未配置：请先在页面「模型与服务」保存供应商地址与 API Key，或设置 PROMO_ONEAPI_BASE_URL / PROMO_ONEAPI_API_KEY");
  const url = base.replace(/\/$/, "") + path;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let res;
  try {
    res = await (globalThis.fetch || fetch)(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
  } catch (e) {
    clearTimeout(timer);
    throw new Error(`one-api ${path} 请求失败：${e?.message || e}`);
  }
  clearTimeout(timer);
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    const err = new Error(`one-api ${path} ${res.status}: ${txt.slice(0, 300)}`);
    err.status = res.status;
    throw err;
  }
  if (isBinary) return Buffer.from(await res.arrayBuffer());
  return res.json();
}

// GET 辅助（视频异步任务轮询等只读查询复用同一 base/key 约定）。
async function oneApiGet(path, { timeoutMs = 15000 } = {}) {
  const base = getEffectiveOneApiBase();
  const key = activeKey();
  if (!base || !key) throw new Error("one-api 未配置：请先在页面「模型与服务」保存供应商地址与 API Key，或设置 PROMO_ONEAPI_BASE_URL / PROMO_ONEAPI_API_KEY");
  const url = base.replace(/\/$/, "") + path;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let res;
  try {
    res = await fetch(url, { headers: { Authorization: `Bearer ${key}` }, signal: ctrl.signal });
  } catch (e) {
    clearTimeout(timer);
    throw new Error(`one-api GET ${path} 失败：${e?.message || e}`);
  }
  clearTimeout(timer);
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    const err = new Error(`one-api GET ${path} ${res.status}: ${txt.slice(0, 300)}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

function parseJSONSafe(s) {
  try {
    return JSON.parse(s);
  } catch {
    const m = s.match(/\{[\s\S]*\}/);
    if (m) {
      try {
        return JSON.parse(m[0]);
      } catch {
        return {};
      }
    }
    return {};
  }
}
function estimateTokens(s = "") {
  // 粗略估算（中文约 1.5 字/token，英文约 4 字符/token）。仅用于成本预估兜底。
  return Math.max(1, Math.round(s.length / 2));
}
function mapVoiceTone(tone = "男声") {
  const t = tone.toLowerCase();
  // 返回 OpenAI 标准 voice 名（MiniMax/speech 等兼容渠道只认这套，male/female/young 会 406）
  if (t.includes("女")) return "nova";
  if (t.includes("活泼")) return "shimmer";
  return "onyx"; // 沉稳/男声/默认
}

// ───────────────────────── 1) LLM：脚本生成 ─────────────────────────
export async function generateScript(brief) {
  if (getProviderMode() !== "real") return demoScript(brief);
  const model = brief.llmModel || process.env.PROMO_LLM_MODEL || "deepseek-v4-flash";
  const sys = "你是资深品牌文案，依据品牌简报产出宣传片脚本，严格只输出 JSON（不含解释），结构：{title, voiceover:[{timecode,text}], structure:[], moodCurve:[]}。";
  let user =
    `品牌：${brief.brandName}\n产品：${brief.productName}\n核心卖点：${brief.coreSellingPoint}\n` +
    `受众：${(brief.audience || []).join("、")}\n调性：${(brief.tones || []).join("、")}\n` +
    `核心信息：${(brief.keyMessages || []).join("；")}\n时长：${brief.durationSec}s\n` +
    `配音音色：${brief.voiceTone}\n` +
    `voiceover 需按时长均分时间轴（timecode 格式 HH:MM:SS.mmm），结构含开场钩子/痛点/方案/卖点/CTA。`;
  if (brief.bannedWords?.length) user += `\n禁用词：${brief.bannedWords.join("、")}，避免在旁白与字幕中出现。`;
  user = withGlobalLanguage(user, brief.language);
  const data = await oneApiPost("/chat/completions", {
    model,
    messages: [
      { role: "system", content: sys },
      { role: "user", content: user },
    ],
    response_format: { type: "json_object" },
    temperature: 0.7,
  });
  const content = data.choices?.[0]?.message?.content || "{}";
  const parsed = parseJSONSafe(content);
  const tokens = data.usage?.total_tokens ?? estimateTokens(user + content);
  const fallback = demoScript(brief);
  return {
    title: parsed.title || fallback.title,
    voiceover: parsed.voiceover?.length ? parsed.voiceover : fallback.voiceover,
    structure: parsed.structure?.length ? parsed.structure : fallback.structure,
    moodCurve: parsed.moodCurve?.length ? parsed.moodCurve : fallback.moodCurve,
    language: brief.language || "zh-CN",
    model, // 实际使用的 LLM 模型（brief.llmModel 请求级覆盖 > env 默认），供前端展示
    _usage: { tokens },
  };
}

function demoScript(brief) {
  const seed = hashSeed(brief.brandName + brief.coreSellingPoint);
  const rnd = mulberry32(seed);
  const dur = brief.durationSec || 30;
  const lines = Math.max(3, Math.round(dur / 6));
  const brand = brief.brandName || "品牌";
  const product = brief.productName || "产品";
  const sp = brief.coreSellingPoint || "核心卖点";
  const lang = brief.language || "zh-CN";

  const openers =
    lang === "zh-CN" || lang === "zh-TW"
      ? [
          `你是否也在为「${brief.audience?.join("、") || "用户"}」的痛点发愁？`,
          `今天，让${brand}给你一个不一样的答案。`,
          `当别人还在将就，${brand}已经替你想好了每一步。`,
        ]
      : [
          `Tired of the same old problems in ${brief.audience?.[0] || "your industry"}?`,
          `Today, ${brand} changes the game.`,
          `While others compromise, ${brand} thinks ahead.`,
        ];

  const voiceover = [];
  let t = 0;
  const per = dur / lines;
  for (let i = 0; i < lines; i++) {
    let text;
    if (i === 0) text = pick(openers, rnd);
    else if (i === lines - 1)
      text =
        lang === "zh-CN" || lang === "zh-TW"
          ? `选择${brand}${product}，让${sp}，现在就行动。`
          : `Choose ${brand} ${product} — ${sp}. Act now.`;
    else
      text =
        lang === "zh-CN" || lang === "zh-TW"
          ? `${product}的${sp}，正是你需要的解法。`
          : `${product}'s ${sp} is exactly what you need.`;
    voiceover.push({ timecode: fmtTC(t), text });
    t += per;
  }

  const structure = [
    lang === "zh-CN" ? "开场钩子" : "Hook",
    lang === "zh-CN" ? "痛点共鸣" : "Pain",
    lang === "zh-CN" ? "方案呈现" : "Solution",
    lang === "zh-CN" ? "卖点强化" : "Selling point",
    lang === "zh-CN" ? "行动号召" : "CTA",
  ];
  const moodCurve = ["平静", "张力", "希望", "高潮", "满足"];
  return {
    title: `${brand} · ${product} 宣传片`,
    voiceover,
    structure,
    moodCurve,
    language: lang,
    model: brief.llmModel || "demo-llm", // DEMO 下为声明路由；切 real 后即真实调用该模型
  };
}

// ───────────────────────── 2) LLM：分镜生成 ─────────────────────────
export async function generateStoryboard(brief, script) {
  if (getProviderMode() !== "real") return demoStoryboard(brief, script);
  const model = brief.llmModel || process.env.PROMO_LLM_MODEL || "deepseek-v4-flash";
  const sys = "你是资深分镜师，把脚本拆为若干 Scene，严格只输出 JSON 数组，结构：[{index, visualPrompt, subtitle, camera, durationSec, musicClimax}]。";
  const vo = (script?.voiceover || []).map((v) => `${v.timecode} ${v.text}`).join("\n");
  let user =
    `品牌：${brief.brandName} 产品：${brief.productName}\n调性：${(brief.tones || []).join("、")}\n` +
    `时长：${brief.durationSec}s\n旁白：\n${vo}\n` +
    `约每 5s 一个镜头；camera ∈ push/pull/pan/fixed；视觉风格全程统一。`;
  if (brief.bannedWords?.length) user += `\n禁用词：${brief.bannedWords.join("、")}。`;
  if (brief.logoColor) user += `\n品牌主色 ${brief.logoColor}，画面配色需呼应。`;
  user = withGlobalLanguage(user, brief.language);
  const data = await oneApiPost("/chat/completions", {
    model,
    messages: [
      { role: "system", content: sys },
      { role: "user", content: user },
    ],
    response_format: { type: "json_object" },
    temperature: 0.7,
  });
  const content = data.choices?.[0]?.message?.content || "{}";
  const parsed = parseJSONSafe(content);
  const arr = Array.isArray(parsed) ? parsed : parsed.scenes || [];
  const tokens = data.usage?.total_tokens ?? estimateTokens(user + content);
  if (!arr.length) return demoStoryboard(brief, script);
  const scenes = arr.map((s, i) => ({
    index: s.index || i + 1,
    visualPrompt: s.visualPrompt || `${brief.brandName} ${brief.productName} 画面`,
    subtitle: s.subtitle || script?.voiceover?.[i]?.text || `场景 ${i + 1}`,
    camera: ["push", "pull", "pan", "fixed"].includes(s.camera) ? s.camera : "fixed",
    durationSec: Number(s.durationSec) || Math.round((brief.durationSec / arr.length) * 10) / 10,
    musicClimax: !!s.musicClimax,
    status: "pending",
  }));
  return scenes.map((s) => ({ ...s, _usage: { tokens: Math.round(tokens / scenes.length) } }));
}

function demoStoryboard(brief, script) {
  const seed = hashSeed(brief.brandName + (script?.title || ""));
  const rnd = mulberry32(seed);
  const dur = brief.durationSec || 30;
  const n = Math.max(3, Math.round(dur / 5));
  const tones = brief.tones || ["专业"];
  const scenes = [];
  for (let i = 0; i < n; i++) {
    const camera = pick(["push", "pull", "pan", "fixed"], rnd);
    scenes.push({
      index: i + 1,
      visualPrompt: `${brief.brandName} ${brief.productName} 的${pick(tones, rnd)}风格画面，镜头${camera}，突出${brief.coreSellingPoint}`,
      subtitle: script?.voiceover?.[i]?.text || `场景 ${i + 1}`,
      camera,
      durationSec: Math.round((dur / n) * 10) / 10,
      musicClimax: i === n - 1,
      status: "pending",
    });
  }
  return scenes;
}

// ───────────────────────── 3) 图像/视频素材 ─────────────────────────
export async function generateSceneMedia(scene, brief) {
  if (getProviderMode() !== "real") return demoSceneMedia(scene, brief);
  const model = brief.imageModel || process.env.PROMO_IMAGE_MODEL || "doubao-seedream-4-0-250828";
  let prompt = scene.visualPrompt;
  if (brief.logoColor) prompt += `；主色 ${brief.logoColor}`;
  // 渠道适配：doubao/seedream 系渠道 size 词汇为 1K|2K|4K（像素写法会 400），
  //   并接受 aspect_ratio 控制画幅（宣传片默认 16:9 横版）；其余渠道保持像素尺寸写法。
  const isSeedream = /seedream|doubao/i.test(model);
  let size = process.env.PROMO_IMAGE_SIZE || (isSeedream ? "1K" : "1024x576");
  const body = { model, prompt, n: 1, size };
  if (isSeedream) {
    if (/^\d{3,4}x\d{3,4}$/.test(size)) body.size = "1K"; // 旧像素默认 → 词汇
    body.aspect_ratio = process.env.PROMO_IMAGE_ASPECT || "16:9";
  }
  // M3-D 真实参考图图生图（Seedream 参考图输入，M2 仅关键词透传）：
  //   styleReference 为 data:image 或 http(s) URL → 作为 image 字段走图生图（参考图输入免费，见 PRD §10）。
  //   纯关键词（非 URL）→ 追加到 prompt（M2 行为，向后兼容）。
  const ref = brief.styleReference;
  if (ref) {
    if (/^data:image\//i.test(ref)) {
      body.image = ref.replace(/^data:image\/[^;]+;base64,/, ""); // 去前缀，留 base64
    } else if (/^https?:\/\//i.test(ref)) {
      body.image = ref; // one-api 支持 URL 参考图
    } else {
      body.prompt = `${prompt}；参考风格：${ref}`;
    }
  }
  const data = await oneApiPost("/images/generations", body);
  const item = data.data?.[0] || {};
  const mediaUrl = item.url || (item.b64_json ? `data:image/png;base64,${item.b64_json}` : null);
  return { mediaUrl, kind: "image", model, _usage: { images: 1 } };
}

function demoSceneMedia(scene, brief) {
  let [c1, c2] = paletteFor(brief.tones);
  if (brief.logoColor) c1 = brief.logoColor; // M4 模板库：Logo 主色优先
  const svg = buildPosterSVG(scene, brief, c1, c2);
  return { mediaUrl: encodeSVG(svg), kind: "image", model: brief.imageModel || "demo-seedream" };
}

// ───────────────────────── 3.5) 动态视频（图生/文生，OpenAI 兼容 /videos/generations + new-api 单数回退） ─────────────────────────
// 仅 real 模式且 Brief.videoModel 存在时由 workflow 调用；DEMO 一律走 demoSceneVideo（静态图声明路由）。
// 请求级模型 = Brief.videoModel；场景图 URL（http(s)）作为 image 字段 → 图生视频（首帧驱动，风格连贯），
// 无图（图生成失败）→ 退化为文生视频（仅 prompt）。
// 响应兼容两种形态：
//   a) 同步：{ data:[{url}] } 或 { url } —— 直接返回；
//   b) 异步任务：{ id, status } / { data:[{id}] } —— 轮询任务端点。
// 端点差异（真实对拍，2026-09）：OpenAI 规范为复数 /videos/generations，但 new-api v0.13.2 网关
//   实测只注册**单数** /v1/video/generations（复数 404 "Invalid URL"）→ 提交 404 自动回退单数；
//   轮询序列 /videos/{id} → /videos/generations/{id} → /video/generations/{id}。
//   new-api 任务查询返回包装 {code:"success", data:{status:"SUCCESS"|"FAILURE", result_url, fail_reason}} →
//   unwrapTask 解包 data 层。
// 单镜失败由 workflow 捕获降级为静态图（不阻断全片，FR-4.3）；超时受 PROMO_VIDEO_TIMEOUT_MS 控制（默认 180s）。
const VIDEO_SUBMIT_PATHS = ["/videos/generations", "/video/generations"];
const VIDEO_POLL_PATHS = (id) => [`/videos/${id}`, `/videos/generations/${id}`, `/video/generations/${id}`];

export async function generateSceneVideo(scene, brief) {
  if (getProviderMode() !== "real") return demoSceneVideo(scene, brief);
  const model = brief.videoModel || process.env.PROMO_VIDEO_MODEL;
  if (!model) throw new Error("未指定视频模型（Brief.videoModel / env PROMO_VIDEO_MODEL）");
  let prompt = scene.visualPrompt || scene.subtitle || "";
  if (brief.logoColor) prompt += `；主色 ${brief.logoColor}`;
  const body = { model, prompt, n: 1 };
  const ref = scene.mediaUrl;
  if (ref && /^https?:\/\//i.test(ref)) body.image = ref; // 图生视频：首帧用本镜场景图
  const timeoutMs = Number(process.env.PROMO_VIDEO_SUBMIT_TIMEOUT_MS ?? 30000);
  let data = null, submitErr = null;
  for (const p of VIDEO_SUBMIT_PATHS) {
    try {
      data = await oneApiPost(p, body, { timeoutMs });
      submitErr = null;
      break;
    } catch (e) {
      submitErr = e;
      if (e.status !== 404 && !/Invalid URL/i.test(String(e.message))) throw e; // 非路径问题直接抛
    }
  }
  if (!data) throw submitErr || new Error("视频提交失败（所有端点均不可用）");
  const videoUrl = extractVideoUrl(data);
  if (videoUrl) return { videoUrl, kind: "video", model, _usage: { videos: 1 } };
  // 异步任务：轮询直至完成
  const id = data?.id || data?.data?.[0]?.id || data?.task_id || data?.request_id;
  if (!id) throw new Error(`视频接口未返回 url 或任务 id：${JSON.stringify(data).slice(0, 200)}`);
  const deadline = Date.now() + Number(process.env.PROMO_VIDEO_TIMEOUT_MS ?? 180000);
  let lastErr = null;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, Number(process.env.PROMO_VIDEO_POLL_MS ?? 3000)));
    let task = null;
    for (const p of VIDEO_POLL_PATHS(id)) {
      try {
        task = await oneApiGet(p);
        break;
      } catch (e) {
        lastErr = e;
        if (e.status !== 404 && !/Invalid URL/i.test(String(e.message))) break; // 非路径问题停止尝试该轮
      }
    }
    if (!task) continue;
    const body2 = unwrapVideoTask(task);
    const status = String(body2?.status || body2?.state || "").toLowerCase();
    const url = body2?.result_url || extractVideoUrl(body2);
    if (url) return { videoUrl: url, kind: "video", model, _usage: { videos: 1 }, taskStatus: status };
    if (["failed", "failure", "error", "cancelled", "canceled"].includes(status)) {
      throw new Error(`视频任务 ${id} 失败：${body2?.fail_reason || body2?.error || body2?.message || status}`);
    }
    if (["completed", "succeeded", "success", "finished"].includes(status) && !url) {
      throw new Error(`视频任务 ${id} 完成但未返回 URL：${JSON.stringify(task).slice(0, 200)}`);
    }
  }
  throw new Error(`视频任务 ${id} 轮询超时（>${Number(process.env.PROMO_VIDEO_TIMEOUT_MS ?? 180000) / 1000}s）${lastErr ? `，最近错误：${String(lastErr?.message || lastErr)}` : ""}`);
}

// new-api 任务查询包装解包：{code:"success", data:{status, result_url, fail_reason}} → 返回 data 层。
function unwrapVideoTask(raw) {
  if (raw && raw.code && raw.data && typeof raw.data === "object" && !Array.isArray(raw.data)) {
    const d = raw.data;
    if ("status" in d || "result_url" in d || "fail_reason" in d) return d;
  }
  return raw;
}

// 从视频接口响应中提取首个可用 URL。兼容常见形态：
//   顶层 { url | video_url }；data/output/results/videos 数组（元素为 string 或 {url|video_url|content.url}）；
//   output 为对象 { url | video_url | content:{url} }；内容门控 {content:[{url}]} 等。
function extractVideoUrl(data) {
  if (!data) return null;
  const first = (list) => {
    if (!Array.isArray(list)) return null;
    for (const it of list) {
      if (typeof it === "string" && it) return it;
      if (!it) continue;
      if (typeof it.url === "string" && it.url) return it.url;
      if (typeof it.video_url === "string" && it.video_url) return it.video_url;
      if (it.content) {
        const c = it.content;
        if (typeof c === "string" && c) return c;
        if (typeof c.url === "string" && c.url) return c.url;
        if (Array.isArray(c)) {
          for (const ci of c) {
            if (typeof ci?.url === "string" && ci.url) return ci.url;
            if (typeof ci === "string" && ci) return ci;
          }
        }
      }
    }
    return null;
  };
  for (const key of ["url", "video_url", "result_url"]) {
    if (typeof data[key] === "string" && data[key]) return data[key];
  }
  const hit = first(data.data || data.results || data.videos);
  if (hit) return hit;
  // output 可能为数组（多候选）或单个对象
  if (Array.isArray(data.output)) return first(data.output);
  if (data.output && typeof data.output === "object") {
    const o = data.output;
    for (const key of ["url", "video_url"]) {
      if (typeof o[key] === "string" && o[key]) return o[key];
    }
    if (o.content) {
      const c = o.content;
      if (typeof c === "string" && c) return c;
      if (typeof c.url === "string" && c.url) return c.url;
      if (Array.isArray(c)) {
        for (const ci of c) {
          if (typeof ci?.url === "string" && ci.url) return ci.url;
          if (typeof ci === "string" && ci) return ci;
        }
      }
    }
  }
  return null;
}

// DEMO：不真调视频接口 —— 沿用静态场景图（动态镜头在 real 模式由网关视频渠道产出）。
function demoSceneVideo(scene, brief) {
  return { videoUrl: null, kind: "video-stub", model: brief.videoModel || "demo-video", note: "DEMO：未调用视频接口，出片仍为静态图合成" };
}

// ───────────────────────── 4) TTS 配音 ─────────────────────────
export async function generateVoiceover(script, brief) {
  if (getProviderMode() !== "real") return demoVoiceover(script, brief);
  const model = process.env.PROMO_TTS_MODEL || "tiny-iceberg";
  const text = (script?.voiceover || []).map((v) => v.text).join("\n");
  // response_format 是 OpenAI 专属字段：MiniMax speech 系上游只认自己的 output_format(hex|url)，带它会 406。
  // 仅在 OpenAI 原生系模型名（tts-1*/gpt-4o-mini-tts）时携带，其余（speech-* 等）不带，网关默认 mp3。
  const openaiTts = /^tts-|gpt-4o-mini-tts/.test(model);
  const body = { model, input: text, voice: mapVoiceTone(brief.voiceTone), language: brief.language || "zh-CN" };
  if (openaiTts) body.response_format = "mp3";
  const audio = await oneApiPost("/audio/speech", body, { isBinary: true });
  const voiceUrl = `data:audio/mp3;base64,${audio.toString("base64")}`;
  const srt = (script?.voiceover || [])
    .map((v, i) => `${i + 1}\n${v.timecode} --> ${fmtTC((i + 1) * 3)}\n${v.text}\n`)
    .join("\n");
  const minutes = (script?.voiceover?.length || 1) * 3 / 60;
  return { voiceUrl, srt, voiceTone: brief.voiceTone || "男声", model, _usage: { minutes } };
}

function demoVoiceover(script, brief) {
  const srt = (script?.voiceover || [])
    .map((v, i) => `${i + 1}\n${v.timecode} --> ${fmtTC((i + 1) * 3)}\n${v.text}\n`)
    .join("\n");
  return { voiceUrl: null, srt, voiceTone: brief.voiceTone || "男声", model: "demo-tts" };
}

// ───────────────────────── 5) 音乐（Mureka 桥 / one-api 音乐通道） ─────────────────────────
export async function generateMusic(brief, storyboard) {
  if (getProviderMode() !== "real") return demoMusic(brief);
  const model = process.env.PROMO_MUSIC_MODEL || "mureka-v1";
  const path = process.env.PROMO_MUSIC_PATH || "/audio/music";
  const prompt = `背景音乐：${(brief.tones || ["专业"]).join("/")}风格，匹配宣传片情绪曲线`;
  const data = await oneApiPost(path, { model, prompt, lyrics: "", instrumental: true });
  const item = data.data?.[0] || {};
  const musicUrl = item.url || (item.b64_json ? `data:audio/mp3;base64,${item.b64_json}` : null);
  return { musicUrl, mood: (brief.tones || ["专业"]).join("/"), model, _usage: { tracks: 1 } };
}

function demoMusic(brief) {
  return { musicUrl: null, mood: (brief.tones || ["专业"]).join("/"), model: "demo-mureka" };
}

// ───────────────────────── 6) 合成（服务端 FFmpeg） ─────────────────────────
export async function composite(scenes, voice, music, brief) {
  if (getProviderMode() !== "real") return demoComposite(scenes, voice, music, brief);
  const ffmpeg = process.env.PROMO_FFMPEG_BIN;
  const gallery = scenes.map((s) => ({ index: s.index, mediaUrl: s.mediaUrl, subtitle: s.subtitle }));
  if (!ffmpeg) {
    return fallbackComposite(scenes, voice, music, brief, "未配置 PROMO_FFMPEG_BIN，已降级为分镜包");
  }
  try {
    const videoUrl = await ffmpegAssemble(ffmpeg, scenes, voice, music, brief);
    return {
      videoUrl,
      poster: scenes[0]?.mediaUrl || null,
      storyboardGallery: gallery,
      srt: voice?.srt || "",
      note: "已合成为 MP4（服务端 FFmpeg）。",
      model: "ffmpeg",
      _usage: { videos: 1 },
    };
  } catch (e) {
    return fallbackComposite(scenes, voice, music, brief, `合成失败已降级：${String(e?.message || e)}`);
  }
}

function fallbackComposite(scenes, voice, music, brief, reason) {
  return {
    videoUrl: null,
    poster: scenes[0]?.mediaUrl || null,
    storyboardGallery: scenes.map((s) => ({ index: s.index, mediaUrl: s.mediaUrl, subtitle: s.subtitle })),
    srt: voice?.srt || "",
    note: `DEMO/降级模式：${reason}（生产环境将合成为 MP4）。`,
    model: "demo-composite",
  };
}

function demoComposite(scenes, voice, music, brief) {
  return fallbackComposite(scenes, voice, music, brief, "未接入真实合成服务，以下为分镜故事板");
}

// 服务端 FFmpeg 组装：将场景图/动态片段 + 配音 + 配乐合为 MP4。要求 ffmpeg 可用且素材可本地读取。
async function ffmpegAssemble(ffmpeg, scenes, voice, music, brief) {
  // 动态视频路径：全部镜均已产出动态片段（scene.videoUrl）→ concat demuxer 直拼 + 音频混流。
  // 前提：同一渠道同设置产物编码/尺寸一致（concat demuxer 流复制不转码）；不一致或失败由外层 catch 降级。
  const videoScenes = scenes.filter((s) => s.videoUrl);
  if (videoScenes.length === scenes.length && videoScenes.length > 0) {
    return ffmpegAssembleVideo(ffmpeg, scenes, voice, music, brief);
  }
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const { execFileSync } = await import("node:child_process");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "promo-"));
  // 静态图幻灯路径：每张图以 -loop 1 -t <dur> 作为独立输入，concat filter 拼接。
  // 不用 concat demuxer 的 duration 指令 —— 它对单帧图片的"最后一段时长"不可靠（末图只出 1 帧）。
  const inputs = [];
  const imgArgs = [];
  const n = scenes.length;
  for (let i = 0; i < n; i++) {
    const s = scenes[i];
    const img = path.join(tmp, `s${i}.img`);
    if (s.mediaUrl?.startsWith("data:image")) {
      const b64 = s.mediaUrl.split(",")[1];
      fs.writeFileSync(img, Buffer.from(b64, "base64"));
    } else if (s.mediaUrl?.startsWith("http")) {
      // 远程图需可访问；此处用 curl 拉取（生产建议预下载到对象存储）。
      execFileSync("curl", ["-sL", s.mediaUrl, "-o", img]);
    } else {
      throw new Error(`第 ${s.index} 镜场景图缺失，无法合成`);
    }
    // 按内容魔数选真实扩展名（JPEG 字节不可当 .png 喂 ffmpeg；seedream 等渠道返回 jpg/webp 常见）。
    const head = fs.readFileSync(img).subarray(0, 12);
    let ext = ".png";
    if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) ext = ".jpg";
    else if (head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e) ext = ".png";
    else if (head.toString("latin1").startsWith("RIFF") && head.subarray(8, 12).toString("latin1") === "WEBP") ext = ".webp";
    const file = path.join(tmp, `s${i}${ext}`);
    fs.renameSync(img, file);
    const dur = (s.durationSec || 5).toFixed(2);
    imgArgs.push("-loop", "1", "-t", dur, "-framerate", "25", "-i", file);
  }
  // 音频输入紧随图像之后：voice 为 n 号、music 为 n+1 号（audioInputs 存 ["-i",file] 对，须用 audioCount 计输入流数）
  let voiceIdx = -1, musicIdx = -1;
  const audioInputs = [];
  let audioCount = 0;
  if (voice?.voiceUrl?.startsWith("data:audio")) {
    const a = path.join(tmp, "voice.mp3");
    fs.writeFileSync(a, Buffer.from(voice.voiceUrl.split(",")[1], "base64"));
    voiceIdx = n + audioCount++;
    audioInputs.push("-i", a);
  }
  if (music?.musicUrl?.startsWith("data:audio")) {
    const m = path.join(tmp, "music.mp3");
    fs.writeFileSync(m, Buffer.from(music.musicUrl.split(",")[1], "base64"));
    musicIdx = n + audioCount++;
    audioInputs.push("-i", m);
  }
  const out = path.join(tmp, "out.mp4");
  // 统一画布：seedream/doubao 等渠道对 aspect_ratio 是 best-effort，同一批场景图可能混出不同几何
  //（实测 5 镜返回 1152×864 / 864×1152 竖图 / 1312×736×3）。concat filter 要求输入几何完全一致 →
  // 每镜先 scale+pad 归一到 1280×720(16:9) 画布（黑边 letterbox、不裁剪），再 concat，杜绝尺寸不匹配。
  const CW = 1280, CH = 720;
  const norm = scenes
    .map((_, i) => `[${i}:v]scale=${CW}:${CH}:force_original_aspect_ratio=decrease,pad=${CW}:${CH}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,format=yuv420p[v${i}]`)
    .join(";");
  const joined = scenes.map((_, i) => `[v${i}]`).join("");
  let fc = `${norm};${joined}concat=n=${n}:v=1:a=0[vout]`;
  const maps = ["-map", "[vout]"];
  if (voiceIdx >= 0 && musicIdx >= 0) {
    fc += `;[${voiceIdx}:a][${musicIdx}:a]amix=inputs=2:duration=longest[aout]`;
    maps.push("-map", "[aout]");
  } else if (voiceIdx >= 0) {
    maps.push("-map", `${voiceIdx}:a`);
  } else if (musicIdx >= 0) {
    maps.push("-map", `${musicIdx}:a`);
  }
  // 以画面总时长为准（voice/music 短则尾部静音、长则被截）；-shortest 会把画面截到最短音轨，故不用。
  const totalSec = scenes.reduce((a, s) => a + (s.durationSec || 5), 0).toFixed(2);
  const args = ["-y", ...imgArgs, ...audioInputs, "-filter_complex", fc, ...maps, "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-t", totalSec, "-y", out];
  try {
    execFileSync(ffmpeg, args, { stdio: "pipe" });
  } catch (e) {
    const stderr = String(e?.stderr || "");
    const detail = (stderr.split("\n").filter(Boolean).slice(-6).join("\n")).slice(0, 500);
    throw new Error(`ffmpeg 合成失败：${String(e?.message || e).slice(0, 100)}${detail ? ` :: ${detail}` : ""}`);
  }
  // 返回本地文件路径（生产应上传对象存储并返回直链）
  return `file://${out}`;
}

// 动态片段直拼：全部镜为 mp4 片段（本地 file:// 或可下载 http(s)）→ concat demuxer + 音频 amix。
// 注意：真实渠道产物通常同编码同尺寸可直接流复制；若渠道混用导致失败，会落到 fallbackComposite 提示。
async function ffmpegAssembleVideo(ffmpeg, scenes, voice, music, brief) {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const { execFileSync } = await import("node:child_process");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "promo-vid-"));
  const list = path.join(tmp, "list.txt");
  const lines = [];
  for (let i = 0; i < scenes.length; i++) {
    const s = scenes[i];
    const vf = path.join(tmp, `v${i}.mp4`);
    const url = s.videoUrl;
    if (url?.startsWith("file://")) {
      fs.copyFileSync(url.slice(7), vf);
    } else if (url?.startsWith("http")) {
      execFileSync("curl", ["-sL", url, "-o", vf]);
    } else if (url?.startsWith("data:video")) {
      fs.writeFileSync(vf, Buffer.from(url.split(",")[1], "base64"));
    } else {
      throw new Error(`第 ${s.index} 镜视频 URL 无法本地化：${String(url || "空").slice(0, 80)}`);
    }
    if (!fs.existsSync(vf) || fs.statSync(vf).size < 100) throw new Error(`第 ${s.index} 镜视频下载失败/为空`);
    lines.push(`file '${vf.replace(/'/g, "'\\''")}'`);
  }
  fs.writeFileSync(list, lines.join("\n"));
  const out = path.join(tmp, "out.mp4");
  const args = ["-f", "concat", "-safe", "0", "-i", list];
  if (voice?.voiceUrl?.startsWith("data:audio")) {
    const a = path.join(tmp, "voice.mp3");
    fs.writeFileSync(a, Buffer.from(voice.voiceUrl.split(",")[1], "base64"));
    args.push("-i", a);
    if (music?.musicUrl?.startsWith("data:audio")) {
      const m = path.join(tmp, "music.mp3");
      fs.writeFileSync(m, Buffer.from(music.musicUrl.split(",")[1], "base64"));
      args.push("-i", m, "-filter_complex", "[1:a][2:a]amix=inputs=2[a]", "-map", "0:v", "-map", "[a]");
    } else {
      args.push("-map", "0:v", "-map", "1:a");
    }
  }
  // 以画面总时长为准（真实配乐常长于画面，须截断；voice 不足尾部静音）
  const totalSec = scenes.reduce((a, s) => a + (s.durationSec || 5), 0).toFixed(2);
  args.push("-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-t", totalSec, "-y", out);
  execFileSync(ffmpeg, args, { stdio: "pipe" });
  return `file://${out}`;
}

// ───────────────────────── 内部工具 ─────────────────────────
function pick(arr, rnd) {
  return arr[Math.floor(rnd() * arr.length) % arr.length];
}
function fmtTC(sec) {
  const s = Math.floor(sec);
  const m = Math.floor(s / 60);
  const ss = (s % 60).toString().padStart(2, "0");
  const ms = Math.floor((sec - s) * 1000)
    .toString()
    .padStart(3, "0");
  return `00:${m.toString().padStart(2, "0")}:${ss}.${ms}`;
}
function buildPosterSVG(scene, brief, c1, c2) {
  const w = 480;
  const h = 270;
  const label = (brief.brandName || "MingStar") + " · " + (scene.subtitle || "");
  const safe = (label || "").slice(0, 28).replace(/[<>&]/g, "");
  return `<svg xmlns='http://www.w3.org/2000/svg' width='${w}' height='${h}' viewBox='0 0 ${w} ${h}'>
  <defs><linearGradient id='g' x1='0' y1='0' x2='1' y2='1'>
    <stop offset='0' stop-color='${c1}'/><stop offset='1' stop-color='${c2}'/></linearGradient></defs>
  <rect width='${w}' height='${h}' fill='url(#g)'/>
  <text x='24' y='48' fill='rgba(255,255,255,0.85)' font-size='20' font-family='sans-serif' font-weight='700'>SCENE ${scene.index}</text>
  <text x='24' y='150' fill='#fff' font-size='18' font-family='sans-serif'>${safe}</text>
  <text x='24' y='240' fill='rgba(255,255,255,0.6)' font-size='13' font-family='sans-serif'>${scene.camera || "fixed"} · ${scene.durationSec}s</text>
</svg>`;
}
