// Provider 抽象层：所有外部能力（LLM / 图像 / TTS / 音乐 / 动态视频 / 合成）均经此适配。
// 默认 DEMO 模式：完全离线、确定性的占位生成，无需任何外部密钥即可端到端运行。
// 生产模式（PROMO_PROVIDER_MODE=real）：经 one-api（OpenAI 兼容统一网关）调用真实能力，
//   图像走 /v1/images/generations（Seedream 等），TTS 走 /v1/audio/speech，音乐走 Mureka 桥
//   （/v1/chat/completions 的 mureka-song 提交 + mureka-query 轮询），
//   动态视频走 /v1/videos/generations（图生/文生，异步任务轮询，PROMO_VIDEO_TIMEOUT_MS 超时）；
//   合成走服务端 FFmpeg（PROMO_FFMPEG_BIN）。每个真实能力回传 _usage 供成本归集。
//
// 切换只需设置环境变量，【工作流代码不变】。本文件不含网络调用时机之外的业务逻辑。

import { encodeSVG } from "./svg.js";
import { withGlobalLanguage } from "../i18n.js";
import { getEffectiveOneApiBase, getEffectiveProviderMode, getEffectiveOneApiKey } from "../runtime-config.js";
import { canvasPrompt, resolveCanvas } from "../media/canvas.js";
import { styleManifest, stylePrompt } from "../media/style.js";
import { MUSIC_QUERY_MODEL, MUSIC_SUBMIT_MODEL } from "../media/model-selection.js";
import { materializeMedia } from "../media/materialize.js";
import { assertSubtitleFilters, composeFinalVideo, normalizeSceneImage, normalizeSceneVideo } from "../media/ffmpeg.js";
import { buildVoiceTimeline, concatenateVoiceSegments, formatSrt, probeAudioDuration, wrapPcmAsWav } from "../media/audio.js";
import { MEDIA_LIMITS } from "../media/artifacts.js";
import { configuredFontPath, fontSupportsChinese, resolveFontFile } from "../media/font-readiness.js";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

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
// 导出：雷达模块（sentiment/topics）的 LLM 调用复用同一 base/key/超时/错误处理，不再各写一份 fetch。
// 说明：base/key 校验与 AbortController 生命周期在此统一，普通 POST 与流式 POST 复用同一约定，避免两处漂移。
function beginOneApiRequest(path, timeoutMs) {
  // base/key = 运行时配置覆盖（前端「模型与服务」保存的供应商地址与密钥）> env 默认；每次调用现取，改完即生效。
  const base = getEffectiveOneApiBase();
  const key = activeKey();
  if (!base || !key) throw new Error("one-api 未配置：请先在页面「模型与服务」保存供应商地址与 API Key，或设置 PROMO_ONEAPI_BASE_URL / PROMO_ONEAPI_API_KEY");
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  return { url: base.replace(/\/$/, "") + path, key, ctrl, timer };
}

// 非 2xx → 面向用户的中文错误。401/503 的网关级提示由两条通道共用，避免同一种故障给出两种文案。
async function oneApiResponseError(res, path, body) {
  const txt = await res.text().catch(() => "");
  if (res.status === 401 && /登录已过期|login expired|unauthorized|invalid token/i.test(txt)) {
    return new Error(/invalid token/i.test(txt)
      ? "New API 拒绝了当前 API Key：请在该 New API 实例重新创建或复制有效令牌，再回到页面保存"
      : "远程地址返回网页登录 401：请改用 OpenAI 兼容中转 API 地址（通常以 /v1 结尾），并填写该中转站生成的 API Key");
  }
  if (res.status === 503 && /model_not_found|No available channel/i.test(txt)) {
    return new Error(`远程中转没有可用的文本模型渠道：当前请求模型未加入该分组。请在 New API 为 API Key 所属分组开通文本模型，或改用包含文本模型的 API Key（当前请求：${body?.model || "未知模型"}）`);
  }
  const err = new Error(`one-api ${path} ${res.status}: ${txt.slice(0, 300)}`);
  err.status = res.status;
  return err;
}

export async function oneApiPost(path, body, { isBinary = false, timeoutMs = 120000 } = {}) {
  const { url, key, ctrl, timer } = beginOneApiRequest(path, timeoutMs);
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
  if (!res.ok) throw await oneApiResponseError(res, path, body);
  if (isBinary) return Buffer.from(await res.arrayBuffer());
  return res.json();
}

// SSE 帧解析：只取 `data:` 行，其余（event:/id:/: 心跳）按协议忽略。
function sseDataPayload(line) {
  if (typeof line !== "string") return null;
  const trimmed = line.trim();
  if (!trimmed.startsWith("data:")) return null;
  const payload = trimmed.slice(5).trim();
  return payload || null;
}

function parseSseEventJson(payload) {
  try {
    return JSON.parse(payload);
  } catch {
    return null; // 非 JSON 帧（厂商心跳）忽略，不阻断后续有效帧。
  }
}

/**
 * 流式 POST（SSE）：Qwen-Omni 语音输出只能以长连接分帧返回，普通 oneApiPost 的整段 JSON 解析会失败。
 *
 * 说明：读取在收到 `[DONE]` 时立即结束 —— 部分中转在终止符后仍保持连接，若等到 EOF 会白等到超时。
 *
 * @param {string} path one-api 相对路径。
 * @param {object} body JSON 请求体。
 * @param {{timeoutMs?: number}} [options] 读取总超时；默认 PROMO_TTS_STREAM_TIMEOUT_MS 或 300000。
 * @returns {Promise<object[]>} 解析后的 SSE 事件对象列表（按到达顺序）。
 * @throws {Error} 网关未配置、请求失败或响应非 2xx 时抛出中文错误。
 * @example await oneApiPostStream("/chat/completions", { model, stream: true });
 */
export async function oneApiPostStream(path, body, { timeoutMs = Number(process.env.PROMO_TTS_STREAM_TIMEOUT_MS || 300000) } = {}) {
  const { url, key, ctrl, timer } = beginOneApiRequest(path, timeoutMs);
  let res;
  try {
    res = await (globalThis.fetch || fetch)(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "text/event-stream", Authorization: `Bearer ${key}` },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
  } catch (e) {
    clearTimeout(timer);
    throw new Error(`one-api ${path} 请求失败：${e?.message || e}`);
  }
  if (!res.ok) {
    clearTimeout(timer);
    throw await oneApiResponseError(res, path, body);
  }
  const events = [];
  let head = "";
  let rawText = "";
  const consume = (line) => {
    const payload = sseDataPayload(line);
    if (!payload) return false;
    if (payload === "[DONE]") return true;
    const event = parseSseEventJson(payload);
    if (event) events.push(event);
    return false;
  };
  try {
    if (!res.body || typeof res.body.getReader !== "function") {
      // 说明：header 可能漏掉 body；用 text() 兜底，并把整段文本留给下方 JSON 兜底解析。
      rawText = String(await res.text());
      head = rawText.slice(0, 4000);
      for (const line of rawText.split("\n")) if (consume(line)) break;
    } else {
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let finished = false;
      while (!finished) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        head = (head + chunk).slice(0, 4000);
        buffer += chunk;
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (consume(line)) { finished = true; break; }
        }
      }
      if (!finished) consume(buffer);
    }
  } catch (e) {
    clearTimeout(timer);
    throw new Error(`one-api ${path} 流式读取失败：${e?.message || e}`);
  }
  clearTimeout(timer);
  // 说明：不支持 SSE 的中转会把整段 JSON 一次性返回（无 data: 帧），此时按普通 JSON 兜底解析。
  const fallbackText = (rawText || head).trim();
  if (events.length === 0 && fallbackText.startsWith("{")) {
    const single = parseSseEventJson(fallbackText);
    if (single) events.push(single);
  }
  return events;
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

// 导出：雷达模块 LLM JSON 响应解析复用（直接 parse → 失败抠首个 {...} 再 parse）。
export function parseJSONSafe(s) {
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
// 分镜数组可能被对象包裹（response_format=json_object 强制顶层为对象），不同模型分别用
// scenes / array / storyboard 等键承载；实测 deepseek-v4-flash 返回 {"array":[...]}。
const SCENE_ARRAY_KEYS = ["scenes", "array", "storyboard", "shots", "list", "items", "分镜"];

/**
 * 从 LLM 返回的 JSON 对象中提取分镜数组，兼容常见键名漂移与一层嵌套。
 *
 * @param {unknown} parsed 已解析的响应内容。
 * @returns {Array<Record<string, any>>} 分镜数组；无法识别时返回空数组。
 * @example
 * extractSceneArray({ array: [{ index: 1 }] });
 */
export function extractSceneArray(parsed) {
  if (Array.isArray(parsed)) return parsed;
  if (!parsed || typeof parsed !== "object") return [];
  const pick = (obj) => {
    for (const key of SCENE_ARRAY_KEYS) {
      if (Array.isArray(obj?.[key])) return obj[key];
    }
    return null;
  };
  const direct = pick(parsed);
  if (direct) return direct;
  for (const key of [...SCENE_ARRAY_KEYS, "data", "result"]) {
    const nested = pick(parsed?.[key]);
    if (nested) return nested;
  }
  // 兜底：模型自造键名时取第一个「元素为对象」的数组，避免整步失败。
  for (const value of Object.values(parsed)) {
    if (Array.isArray(value) && value.some((item) => item && typeof item === "object")) return value;
  }
  return [];
}

/**
 * 从含解释文字或代码块的响应里抠出第一个括号平衡的 JSON 数组字面量。
 *
 * @param {string} text LLM 原始输出。
 * @returns {string | null} 数组字面量；未找到时返回 null。
 * @example
 * sliceFirstJsonArray("结果：\n[{\"index\":1}]");
 */
export function sliceFirstJsonArray(text) {
  const source = String(text ?? "");
  const start = source.indexOf("[");
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < source.length; i += 1) {
    const ch = source[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === "\"") inString = false;
      continue;
    }
    if (ch === "\"") inString = true;
    else if (ch === "[") depth += 1;
    else if (ch === "]") {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  return null;
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
// Omni 备用通道音色映射：该渠道只认自家音色名，OpenAI 的 onyx/nova/shimmer 无效。
// 实测 Ethan 男声、Dylan 活泼男声、Serena 女声可用；Chelsie 返回 0 字节音频，不列入候选。
function omniVoiceFor(tone = "男声") {
  const t = String(tone).toLowerCase();
  if (t.includes("女")) return "Serena";
  if (t.includes("活泼")) return "Dylan";
  return "Ethan"; // 沉稳/男声/默认
}

// 把 Omni 的 SSE 事件流拼成一段裸 PCM。
// 网关按 `choices[0].delta.audio.data` 逐帧下发 base64；文本 delta 一并收集，仅用于错误日志定位。
function collectOmniAudio(events, { model, input }) {
  const chunks = [];
  let transcript = "";
  for (const event of events) {
    const delta = event?.choices?.[0]?.delta;
    if (!delta) continue;
    if (typeof delta.content === "string") transcript += delta.content;
    const data = delta.audio?.data;
    if (typeof data === "string" && data) chunks.push(Buffer.from(data, "base64"));
  }
  const pcm = Buffer.concat(chunks);
  if (pcm.length === 0) {
    const detail = transcript.trim() ? `（模型只返回了文本：${transcript.trim().slice(0, 80)}）` : "";
    throw new Error(`TTS 备用通道 ${model} 未返回音频${detail}，输入：「${String(input).slice(0, 40)}」`);
  }
  return pcm;
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
  const expectedSceneCount = script?.voiceover?.length || 0;
  if (expectedSceneCount === 0) throw new Error("确认脚本没有可生成分镜的旁白");
  // 说明：风格锚点是全片唯一画风来源，必须先进 system prompt；否则模型会在每镜 visualPrompt 里各写一种画风。
  const style = stylePrompt(brief);
  const sys = "你是资深分镜师，把脚本拆为若干 Scene。严格只输出 JSON 对象，形如 {\"scenes\":[{index, visualPrompt, subtitle, camera, durationSec, musicClimax}]}，不得输出解释文字；musicClimax 为布尔值，仅情绪最高点的分镜为 true。" +
    "\n" + style +
    "\nvisualPrompt 只描述画面内容（主体、动作、环境、镜头），不得自行声明或更改画风、光影、材质与配色；全片画风由上述锚点统一决定。";
  const vo = (script?.voiceover || []).map((v) => `${v.timecode} ${v.text}`).join("\n");
  let user =
    `品牌：${brief.brandName} 产品：${brief.productName}\n调性：${(brief.tones || []).join("、")}\n` +
    `时长：${brief.durationSec}s\n旁白：\n${vo}\n` +
    `必须恰好输出 ${expectedSceneCount} 个分镜，与旁白逐句一一对应，不得合并、拆分或增删；` +
    `camera ∈ push/pull/pan/fixed。\n${style}\n${canvasPrompt(brief)}`;
  if (brief.bannedWords?.length) user += `\n禁用词：${brief.bannedWords.join("、")}。`;
  if (brief.logoColor) user += `\n品牌主色 ${brief.logoColor}，画面配色需呼应。`;
  let arr = [];
  let tokens = 0;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const correction = attempt === 0 ? "" : `\n纠正上次输出：上次只解析到 ${arr.length} 个分镜，本次必须严格返回 ${expectedSceneCount} 个，并放在顶层 scenes 数组内。`;
    const attemptUser = withGlobalLanguage(`${user}${correction}`, brief.language);
    try {
      const data = await oneApiPost("/chat/completions", {
        model,
        messages: [
          { role: "system", content: sys },
          { role: "user", content: attemptUser },
        ],
        response_format: { type: "json_object" },
        // 说明：0.7 会让模型对每镜各自发挥画风，与全片锚点相互打架；收紧到 0.4 降低逐镜漂移。
        temperature: 0.4,
      });
      const content = data.choices?.[0]?.message?.content || "{}";
      const parsed = parseJSONSafe(content);
      arr = extractSceneArray(parsed);
      if (arr.length === 0) {
        // 说明：模型偶尔在 JSON 前后夹带解释或代码块，此时 parseJSONSafe 抠对象会失配，补一次数组字面量兜底。
        const rawArray = sliceFirstJsonArray(content);
        if (rawArray) {
          try {
            const direct = JSON.parse(rawArray);
            if (Array.isArray(direct)) arr = direct;
          } catch {
            arr = [];
          }
        }
      }
      tokens += data.usage?.total_tokens ?? estimateTokens(attemptUser + content);
    } catch (error) {
      if (tokens > 0) throw attachPartialUsage(error, { tokens });
      throw error;
    }
    if (arr.length === expectedSceneCount) break;
  }
  if (arr.length !== expectedSceneCount) {
    throw attachPartialUsage(
      new Error(`分镜数量与确认旁白不一致：需要 ${expectedSceneCount} 个，实际 ${arr.length} 个`),
      { tokens },
    );
  }
  const scenes = arr.map((s, i) => ({
    index: s.index || i + 1,
    visualPrompt: s.visualPrompt || `${brief.brandName} ${brief.productName} 画面`,
    subtitle: s.subtitle || script?.voiceover?.[i]?.text || `场景 ${i + 1}`,
    camera: ["push", "pull", "pan", "fixed"].includes(s.camera) ? s.camera : "fixed",
    durationSec: Number(s.durationSec) || Math.round((brief.durationSec / arr.length) * 10) / 10,
    // 说明：部分模型把 musicClimax 给成 0~1 情绪强度而非布尔值，按阈值归一化，避免所有分镜都被判为高潮。
    musicClimax: s.musicClimax === true || (typeof s.musicClimax === "number" && s.musicClimax >= 0.8),
    status: "pending",
  }));
  return scenes.map((s) => ({ ...s, _usage: { tokens: Math.round(tokens / scenes.length) } }));
}

function demoStoryboard(brief, script) {
  const seed = hashSeed(brief.brandName + (script?.title || ""));
  const rnd = mulberry32(seed);
  const dur = brief.durationSec || 30;
  const n = script?.voiceover?.length || Math.max(3, Math.round(dur / 5));
  // 说明：DEMO 分镜也必须与真实链路同源——原来的 pick(tones, rnd) 让每个分镜各挑一种调性，
  // 演示出「一镜一个画风」的假象，也让人无法判断风格锚点是否生效。
  const style = stylePrompt(brief);
  const tone = (brief.tones || ["专业"]).join("、");
  const scenes = [];
  for (let i = 0; i < n; i++) {
    const camera = pick(["push", "pull", "pan", "fixed"], rnd);
    scenes.push({
      index: i + 1,
      visualPrompt: `${brief.brandName} ${brief.productName} 的产品画面，调性 ${tone}，镜头${camera}，突出${brief.coreSellingPoint}；${style}；${canvasPrompt(brief)}`,
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
/**
 * 生成场景图；传入受管目录时立即物化并归一化为所选画布。
 * @param {Record<string, any>} scene 场景描述，归一化成功后写入 `mediaPath`。
 * @param {Record<string, any>} brief 已解析 Brief。
 * @param {{inputsWorkspace?: string, scenesWorkspace?: string}} [options] `artifactPaths(runId)` 提供的受管目录。
 * @returns {Promise<{mediaPath?: string, mediaUrl: string, frameImageUrl?: string, kind: string, model: string, _usage?: object}>} 标准场景图或 DEMO 媒体；
 *   `frameImageUrl` 仅当图像渠道返回公网 http(s) URL 时存在，供图生视频首帧使用（本地标准化文件不能作首帧，见设计文档 §6.2）。
 * @example await generateSceneMedia(scene, brief, { inputsWorkspace: paths.inputs, scenesWorkspace: paths.scenes });
 */
export async function generateSceneMedia(scene, brief, options = {}) {
  if (getProviderMode() !== "real") return demoSceneMedia(scene, brief);
  const model = brief.imageModel || process.env.PROMO_IMAGE_MODEL || "doubao-seedream-4-0-250828";
  const canvas = resolveCanvas(brief.canvasPreset);
  // 说明：风格锚点必须前置——原实现把参考风格追加在末尾，模型已按 visualPrompt 定好画风，尾部约束基本无效。
  let prompt = `${stylePrompt(brief)}；${scene.visualPrompt}；${canvasPrompt(brief)}`;
  if (brief.logoColor) prompt += `；主色 ${brief.logoColor}`;
  // 渠道适配：doubao/seedream 系渠道 size 使用 1K|2K|4K 档位，
  // 并用 aspect_ratio 传递画布比例；其余渠道直接使用受控画布的像素尺寸。
  const isSeedream = /seedream|doubao/i.test(model);
  const configuredSeedreamSize = process.env.PROMO_IMAGE_SIZE;
  const size = isSeedream && /^(1K|2K|4K)$/i.test(configuredSeedreamSize || "")
    ? configuredSeedreamSize.toUpperCase()
    : isSeedream ? "1K" : `${canvas.width}x${canvas.height}`;
  const body = { model, prompt, n: 1, size };
  if (isSeedream) {
    body.aspect_ratio = canvas.aspectRatio;
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
  if (!mediaUrl) throw new Error("图像服务返回空媒体响应");
  // 说明：图生视频的首帧由上游视频渠道自行下载，只接受公网 http(s) URL（data:/本机地址实测被拒），
  // 因此这里把图像渠道的原始公网 URL 一并透传为 frameImageUrl；本地标准化文件只服务预览与合成。
  // b64_json 形态没有公网 URL，此时 frameImageUrl 为空，视频层退化为文生（FR-4.5）。
  const frameImageUrl = isPublicHttpUrl(item.url) ? item.url : undefined;
  if (options.inputsWorkspace && options.scenesWorkspace) {
    const mediaPath = await normalizeSceneImage({
      source: mediaUrl,
      inputsWorkspace: options.inputsWorkspace,
      scenesWorkspace: options.scenesWorkspace,
      canvasPreset: brief.canvasPreset,
    });
    scene.mediaPath = mediaPath;
    return { mediaPath, mediaUrl: pathToFileURL(mediaPath).href, frameImageUrl, kind: "image", model, _usage: { images: 1 } };
  }
  return { mediaUrl, frameImageUrl, kind: "image", model, _usage: { images: 1 } };
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
//   轮询候选按信息完整度排序为 /video/generations/{id} → /videos/generations/{id} → /videos/{id}，
//   同一轮内遍历到可判定结果为止（同一任务 id 只有单数端点返回权威任务形态，见 videoTaskInfo）。
//   new-api 任务查询返回包装 {code:"success", data:{status:"SUCCESS"|"FAILURE", result_url, fail_reason}} →
//   unwrapVideoTask 解包 data 层。
// 失败语义：REAL 模式任一镜失败即整步失败（FR-4.3 已收紧，不再静态降级）；超时受 PROMO_VIDEO_TIMEOUT_MS 控制（默认 600s，minimax-h3 实测单次约 144s，须留足余量）。
// 提交字段：目标渠道对 duration（4~30 整数秒）与 ratio 有硬校验，缺任一项任务会在上游直接失败（minimax-h3 实测）。
const VIDEO_SUBMIT_PATHS = ["/videos/generations", "/video/generations"];
const VIDEO_POLL_PATHS = (id) => [`/video/generations/${id}`, `/videos/generations/${id}`, `/videos/${id}`];
// 视频任务提交的 duration 必须是整数秒，且目标渠道白名单下限为 4s（minimax-h3 实测回报 4~30）。
const VIDEO_DURATION_RANGE = Object.freeze({ min: 4, max: 30 });

/**
 * 计算视频提交应携带的整数秒 duration。
 *
 * 场景时长来自 TTS 实测（如 2.68s），向上取整并夹到渠道允许区间；随后 normalizeSceneVideo 会按权威
 * 时长裁剪或补帧，因此取整不会改变成片节奏。PROMO_VIDEO_DURATION_SEC 可覆盖，供档位离散的渠道使用。
 *
 * @param {{durationSec?: number}} [scene] 含权威语音时长的场景。
 * @returns {number} 4~30 之间的整数秒。
 * @example videoRequestDurationSec({ durationSec: 2.68 }); // 4
 */
function videoRequestDurationSec(scene) {
  const override = Number(process.env.PROMO_VIDEO_DURATION_SEC);
  const measured = Number(scene?.durationSec);
  const base = Number.isFinite(override) && override > 0
    ? override
    : (Number.isFinite(measured) && measured > 0 ? measured : VIDEO_DURATION_RANGE.min);
  return Math.min(VIDEO_DURATION_RANGE.max, Math.max(VIDEO_DURATION_RANGE.min, Math.ceil(base)));
}

/**
 * 归一化视频任务失败原因：优先字符串 fail_reason，其次 error.message，再退 message。
 * 失败原因可能是对象（minimax-h3 实测 {code,message}），直接拼进模板字符串会渲染成 [object Object]。
 *
 * @param {Record<string, any>} task 轮询返回的任务对象。
 * @returns {string} 可读失败原因；无法识别时返回空串。
 * @example videoFailureReason({ error: { message: "ratio is required" } }); // "ratio is required"
 */
function videoFailureReason(task) {
  const candidates = [task?.fail_reason, task?.error?.message, task?.error, task?.message];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
  }
  return "";
}

/**
 * 判断一个值是否为上游可自行下载的公网 http(s) 图片地址。
 *
 * 上游视频渠道用服务端拉取首帧，因此 `data:`、裸 base64、`file:`、本机回环与容器内主机名都不可用；
 * 只放行 http(s) 且主机不是回环/内网地址的 URL，避免把必然失败的值提交给付费任务。
 *
 * @param {unknown} value 待判定的地址。
 * @returns {boolean} 可作为图生视频首帧时返回 true。
 * @example isPublicHttpUrl("https://example.com/s1.png"); // true
 */
function isPublicHttpUrl(value) {
  if (typeof value !== "string" || !/^https?:\/\//i.test(value)) return false;
  let host;
  try {
    host = new URL(value).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (host === "localhost" || host.endsWith(".localhost")) return false;
  if (host === "[::1]" || host === "::1" || host === "0.0.0.0") return false;
  // RFC1918 私网、链路本地与容器内部主机名：上游无法解析或明确拒绝。
  if (/^127\./.test(host) || /^10\./.test(host) || /^192\.168\./.test(host)) return false;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(host) || /^169\.254\./.test(host)) return false;
  if (host.endsWith(".internal") || host.endsWith(".local")) return false;
  return true;
}

// 视频任务终态集合：状态枚举大小写各渠道不一（new-api 用大写 SUCCESS/FAILURE，其余多用小写），统一按小写比对。
const VIDEO_FAILURE_STATUSES = Object.freeze(["failed", "failure", "error", "cancelled", "canceled"]);
const VIDEO_SUCCESS_STATUSES = Object.freeze(["completed", "succeeded", "success", "finished"]);

/**
 * 判断值是否为可物化的成片地址。
 *
 * 说明：上游失败时会把同一段错误文案填进 result_url（实测 `upstream returned unrecognized message`），不做形态校验
 * 就会被当成成片地址去下载并报出误导性错误。这里只放行三种可物化来源 —— http(s): 远端、data: 内联字节、
 * file: 工作区文件（后者仅本地测试与自建存储使用），其余自由文本一律视为无效。
 *
 * @param {unknown} value 待判定值。
 * @returns {boolean} 形如 http(s)://、data: 或 file: 开头时返回 true。
 * @example isMediaUrl("https://cdn.example.com/a.mp4"); // true
 * @example isMediaUrl("upstream returned unrecognized message"); // false
 */
function isMediaUrl(value) {
  return typeof value === "string" && /^(?:https?:|data:|file:)/iu.test(value.trim());
}

/**
 * 归一化单次轮询响应的可判定信息，供「一轮多端点择优」使用。
 *
 * 说明：同一个任务 id 在不同端点的信息完整度不同 —— new-api v0.13.2 实测 /videos/{id} 返回 200 却只有上游原始
 * 形态 {status:"unknown",metadata:{url:""}}（不含失败原因），权威形态只在 /video/generations/{id}
 * {code:"success",data:{status,fail_reason,result_url}}。只看首个 200 会一直轮询到默认超时并丢掉真实原因。
 *
 * @param {unknown} raw 单个轮询端点的响应体。
 * @returns {{status: string, url: string|null, urlPublic: boolean, failReason: string, failed: boolean, done: boolean, score: number}} 归一化信息。
 * @example videoTaskInfo({ code: "success", data: { status: "FAILURE", fail_reason: "boom" } }).failed; // true
 */
function videoTaskInfo(raw) {
  const task = unwrapVideoTask(raw);
  const status = String(task?.status ?? task?.state ?? "").toLowerCase();
  const url = extractVideoUrl(task);
  // 说明：网关会把容器内回环地址填进 result_url（实测 http://localhost:3000/v1/videos/{id}/content），
  // 该地址在宿主机不可达，不能与真正的成片地址等价看待。只有公网可达地址才允许判定「本轮已命中」，
  // 这样同一轮里的其余端点才有机用 metadata.url 的公网签名地址把它覆盖掉。
  const urlPublic = Boolean(url) && isPublicHttpUrl(url);
  const failReason = videoFailureReason(task);
  // 说明：状态可能是 unknown，但只要带着 fail_reason / error 就必须按失败处理；不把 message 算进来 —— 部分渠道用
  // message 表达「排队中」这类正常进度，误判失败等于白扔一次已付费的视频任务。
  const failed = VIDEO_FAILURE_STATUSES.includes(status) || Boolean(task?.fail_reason) || Boolean(task?.error);
  const succeeded = VIDEO_SUCCESS_STATUSES.includes(status);
  return {
    status,
    url,
    urlPublic,
    failReason,
    failed,
    // 说明：有 URL 但不是公网地址时不算命中，继续问同轮其余端点找公网地址；轮次结束仍会退回该地址
    //（不因此判失败或空等超时，保持旧行为），只有「成功终态且完全没有地址」才立刻报完成未返回 URL。
    done: urlPublic || failed || (succeeded && !url),
    // 公网可达地址权重更高：同一轮内权威端点的回环 result_url 不得压过其余端点的公网 metadata.url。
    score: urlPublic ? 3 : (url || failed || succeeded ? 2 : 0),
  };
}

// 单镜视频的瞬时故障重试上限：上游 `unrecognized message` 是偶发故障（2026-09 实测约占 1/3，同一请求重发即可成功），
// 但重试会放大耗时与费用，因此默认只额外重试 1 次（共 2 次）。
const VIDEO_MAX_ATTEMPTS = 3;

/**
 * 解析单镜视频的最大尝试次数。
 *
 * 说明：网关对上游失败任务会自动冲正（logs.type=6），所以对偶发故障重试的净成本接近「只付成功那次」；
 * 上限固定为 3，避免配置错误把一次 run 的费用放大到不可控。
 *
 * @returns {number} 1~3 之间的尝试次数。
 * @example videoAttemptCount(); // 2
 */
function videoAttemptCount() {
  const raw = Number(process.env.PROMO_VIDEO_ATTEMPTS ?? 2);
  if (!Number.isFinite(raw) || raw < 1) return 1;
  return Math.min(VIDEO_MAX_ATTEMPTS, Math.floor(raw));
}

/**
 * 计算视频生成重试的指数退避毫秒数。
 *
 * 说明：上游故障以「成簇时间窗」出现（实测 23:12–23:38 连续失败），线性短退避跑不出窗口，
 * 因此改为 base × 2^(step-1)，并用 PROMO_VIDEO_RETRY_MAX_BACKOFF_MS 封顶，避免极端配置把 run 挂死。
 *
 * @param {number} step 从 1 开始的退避步数（模型内重试用第几次；跨模型降级用「已用尝试数 + 候选序号」）。
 * @returns {number} 等待毫秒数。
 * @example videoRetryBackoffMs(1); // 2000
 */
function videoRetryBackoffMs(step) {
  const base = Number(process.env.PROMO_VIDEO_RETRY_BACKOFF_MS ?? 2000);
  const cap = Number(process.env.PROMO_VIDEO_RETRY_MAX_BACKOFF_MS ?? 30000);
  const value = Number.isFinite(base) && base > 0 ? base : 2000;
  const ceiling = Number.isFinite(cap) && cap > 0 ? cap : 30000;
  return Math.min(ceiling, value * 2 ** Math.max(0, Math.floor(step) - 1));
}

/**
 * 解析单镜视频的候选模型链（主模型在前，降级模型按优先级在后，已去重）。
 *
 * 说明：候选链来自预检写入 Brief 的 videoModel/videoModelFallbacks（同源于 model-selection 的交付优先级），
 * 只在「主模型整镜尝试耗尽」后才换下一个，从而把上游整段故障从「整条 run 失败」降为「换渠道重试」。
 *
 * @param {Record<string, any>} brief 已解析 Brief。
 * @returns {string[]} 候选视频模型 ID；为空表示未指定模型。
 * @example sceneVideoModelCandidates({ videoModel: "minimax-h3", videoModelFallbacks: ["7zhe-seedance"] });
 */
function sceneVideoModelCandidates(brief = {}) {
  const fallbacks = Array.isArray(brief.videoModelFallbacks) ? brief.videoModelFallbacks : [];
  const list = [brief.videoModel || process.env.PROMO_VIDEO_MODEL, ...fallbacks];
  return [...new Set(list.filter((id) => typeof id === "string" && id.trim()))];
}

/**
 * 判断视频错误是否为可重试的上游瞬时故障。
 *
 * 说明：只对上游自身故障重试；请求契约类错误（首帧不合法、字段缺失、参数越界）重发同样会失败，
 * 重试只会多花钱并掩盖真实问题，必须立即抛出。4xx 属于契约或鉴权问题，只有 5xx 才算服务端故障。
 *
 * @param {unknown} error 捕获到的错误。
 * @returns {boolean} 属于瞬时故障时返回 true。
 * @example isTransientVideoError(new Error("视频任务 t1 失败：upstream returned unrecognized message")); // true
 */
export function isTransientVideoError(error) {
  const message = String(error?.message || error || "");
  if (/unrecognized message|upstream returned unrecognized/i.test(message)) return true;
  if (/ECONNRESET|ETIMEDOUT|EPIPE|socket hang up|fetch failed|aborted|network/i.test(message)) return true;
  const status = Number(error?.status);
  return Number.isFinite(status) && status >= 500;
}

/**
 * 判断视频错误是否属于「该渠道整体不可用」（余额不足、分组未开通、无可用渠道）。
 *
 * 说明：这类错误与请求契约无关——同一模型重发必然同样失败（重试纯属浪费），但换下一个候选渠道仍可能出片。
 * 2026-09-22 真实验收中 `7zhe-seedance` 上游账户余额不足返回 403，旧逻辑按契约错误立即抛出，候选链里
 * 本可救场的 `seedance-2.0` 永远没被尝试，整条已付费 run 被判失败。因此这里必须与「契约类错误」区分开。
 *
 * @param {unknown} error 捕获到的错误。
 * @returns {boolean} 属于渠道级不可用时返回 true。
 * @example isChannelUnavailableVideoError(new Error("one-api /video/generations 403: {\"code\":\"insufficient_user_quota\"}")); // true
 */
export function isChannelUnavailableVideoError(error) {
  const message = String(error?.message || error || "");
  // 说明：网关把上游额度不足包在 fail_to_fetch_task 里，关键字可能是英文 code 或中文文案，两种都要命中。
  return /insufficient_user_quota|quota[_ ]?exhausted|预扣费额度失败|额度不足|余额不足|No available channel|model_not_found|无可用渠道|没有可用的.*渠道/i.test(message);
}

/**
 * 判断视频错误是否为「首帧图被上游内容审核拒绝」。
 *
 * 说明：seedance 系渠道对输入图做真人审核，命中即返回 400
 * `InputImageSensitiveContentDetected.PrivacyInformation`（`may contain real person`）。这与「首帧不合法」不同——图本身可用，
 * 只是不能被该渠道当作首帧；同渠道纯文生（usage.input_image_count=0）实测可正常出片（2026-09-22 任务 365）。
 * 各候选渠道都会下载同一张图并被同样拒绝，因此换模型救不了，唯一活路是去掉首帧退化为文生后重试。
 *
 * @param {unknown} error 捕获到的错误。
 * @returns {boolean} 属于首帧内容审核拒绝时返回 true。
 * @example isFrameRejectedVideoError(new Error("400: code=***.PrivacyInformation: may contain real person")); // true
 */
export function isFrameRejectedVideoError(error) {
  const message = String(error?.message || error || "");
  return /InputImageSensitiveContentDetected|PrivacyInformation|may contain real person|输入图.*(敏感|真人)|图片.*疑似真人/i.test(message);
}

/**
 * 生成单个场景视频；传入受管目录时立即物化、按权威场景时长归一化并写入 `videoPath`。
 *
 * 首帧只接受公网 http(s) URL（`scene.frameImageUrl` 优先，其次 `scene.mediaUrl`）；没有公网 URL 时退化为文生视频，
 * 绝不发送 `data:`/本机路径/本机地址——上游会直接拒绝（见设计文档 §6.2 第 5 条）。
 *
 * 说明：外层按「候选模型降级 × 单模型有限重试」两级编排——同一模型内的瞬时故障重试用指数退避，整镜尝试耗尽后
 * 按 Brief.videoModelFallbacks 换下一个渠道（上游整段故障时的唯一活路）；所有候选都失败才向上抛出，
 * 由工作流按 FR-4.3/§7 终止整条 run。契约类错误不换模型，立即抛出；渠道级不可用（余额不足、无可用渠道）
 * 不重发同一模型，直接换下一个候选。首帧图被内容审核拒绝是独立一类：换模型救不了（各渠道下载同一张图会被同样拒绝），
 * 必须去掉首帧退化为文生视频后在同一模型内重试，仍失败才进入常规降级链（见设计文档 §6.2 第 5 条、FR-4.5）。
 *
 * @param {Record<string, any>} scene 已含标准场景图、公网首帧 URL（可选）和权威 `durationSec` 的场景。
 * @param {Record<string, any>} brief 已解析 Brief。
 * @param {{inputsWorkspace?: string, scenesWorkspace?: string}} [options] `artifactPaths(runId)` 提供的受管目录。
 * @returns {Promise<{videoPath?: string, videoUrl: string|null, kind: string, model: string, _usage?: object}>} 标准视频或 DEMO stub。
 * @throws {Error} 重试耗尽、或遇到契约类错误时抛出，错误信息含上游真实原因。
 * @example await generateSceneVideo(scene, brief, { inputsWorkspace: paths.inputs, scenesWorkspace: paths.scenes });
 */
export async function generateSceneVideo(scene, brief, options = {}) {
  if (getProviderMode() !== "real") return demoSceneVideo(scene, brief);
  const attempts = videoAttemptCount();
  const candidates = sceneVideoModelCandidates(brief);
  if (!candidates.length) throw new Error("未指定视频模型（Brief.videoModel / env PROMO_VIDEO_MODEL）");
  let task = null;
  let lastError = null;
  // 说明：仅当本镜确实要带首帧时才可能触发「首帧被内容审核拒绝」，否则去掉首帧等于原样重发（白花一次钱）。
  const canDropFrame = isPublicHttpUrl(scene.frameImageUrl) || isPublicHttpUrl(scene.mediaUrl);
  // 说明：退化标记按「整镜」而不是按「单模型」记。各候选渠道下载的是同一张首帧、审核口径同源（实测均为
  // InputImageSensitiveContentDetected.PrivacyInformation），某个渠道已判定该图不可用作首帧后，后续候选再送同一张图
  // 只会重复被拒并重复产生一次付费提交。退化本身不消耗尝试次数——它与「首帧不合法」不同，是换输入形态而非换参数，
  // 因此按同一次尝试内的形态切换处理，避免 attempts=1 时根本没机会退化就被判整镜失败。
  let frameDropped = false;
  // 说明：外层按候选模型降级，内层按尝试次数重试。上游「整段故障」时同一模型重试再多次也是白等，
  // 只有换到下一个渠道才可能出片；已付费的失败任务由网关自动冲正（logs.type=6），换模型不产生额外净成本。
  for (let candidateIndex = 0; candidateIndex < candidates.length && !task; candidateIndex++) {
    const model = candidates[candidateIndex];
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        // 说明：这里只重试「提交 + 轮询」这段会产生费用的路径。旧实现把 finalizeSceneVideo（含成片下载）
        // 也包在重试里，下载抖动会让同一镜重新提交一次已付费生成任务（2026-09 真实验收两次付费的根因）。
        try {
          task = await requestSceneVideoTask(scene, brief, model, { dropFrame: frameDropped });
          break;
        } catch (error) {
          // 说明：首帧图被上游内容审核拒绝（InputImageSensitiveContentDetected.PrivacyInformation）时，候选链里每个渠道
          // 都会下载同一张图并被同样拒绝，换模型纯属浪费；去掉首帧退化为文生（仅 prompt）才是唯一活路。
          if (!canDropFrame || frameDropped || !isFrameRejectedVideoError(error)) throw error;
          frameDropped = true;
          console.warn(`[video] 第 ${scene.index ?? "?"} 镜模型 ${model} 首帧图被上游内容审核拒绝（${error?.message}），去掉首帧退化为文生视频后重试`);
          task = await requestSceneVideoTask(scene, brief, model, { dropFrame: true });
          break;
        }
      } catch (error) {
        lastError = error;
        // 渠道级不可用（余额不足、分组未开通、无可用渠道）不是瞬时故障，重发同一模型必然同样失败；
        // 但它也不代表请求有问题，换下一个候选渠道仍可能出片，因此跳过本模型剩余尝试直接降级。
        const channelUnavailable = isChannelUnavailableVideoError(error);
        // 契约类错误（4xx、字段缺失、首帧不合法、内容审核拒绝）换模型同样会失败，必须立即抛出。
        if (!isTransientVideoError(error) && !channelUnavailable) throw error;
        const exhaustedModel = channelUnavailable || attempt >= attempts;
        const hasNextModel = candidateIndex < candidates.length - 1;
        if (exhaustedModel && !hasNextModel) throw error;
        // 说明：跨模型降级把「已用尝试数 + 候选序号」作为退避步数，让换渠道前留出更长的观测窗口。
        const waitMs = videoRetryBackoffMs(exhaustedModel ? attempts + candidateIndex + 1 : attempt);
        if (channelUnavailable) {
          console.warn(`[video] 第 ${scene.index ?? "?"} 镜模型 ${model} 渠道不可用（${error?.message}），跳过剩余尝试降级到 ${candidates[candidateIndex + 1]}，${waitMs}ms 后重试`);
        } else if (exhaustedModel) {
          console.warn(`[video] 第 ${scene.index ?? "?"} 镜模型 ${model} 尝试 ${attempts} 次仍失败（${error?.message}），降级到 ${candidates[candidateIndex + 1]}，${waitMs}ms 后重试`);
        } else {
          console.warn(`[video] 第 ${scene.index ?? "?"} 镜模型 ${model} 第 ${attempt}/${attempts} 次失败（${error?.message}），${waitMs}ms 后重试`);
        }
        await new Promise((r) => setTimeout(r, waitMs));
        if (exhaustedModel) break; // 换下一个候选模型
      }
    }
  }
  if (!task) throw lastError || new Error("视频生成失败");
  // 物化与生成重试完全分离：这里失败只会对同一 URL 重试下载/归一化，绝不重新提交付费生成任务。
  return await finalizeSceneVideoWithRetry(task, scene, brief, options);
}

/**
 * 单次尝试：提交视频任务并按候选端点择优轮询到终态，返回成片地址与任务状态。
 *
 * 说明：本函数只负责会付费的「提交 + 轮询」，不下载成片；物化由 finalizeSceneVideoWithRetry 承担，
 * 这样调用方可以只对生成阶段做瞬时故障重试，而下载抖动不会触发重新生成。
 *
 * @param {Record<string, any>} scene 目标场景。
 * @param {Record<string, any>} brief 已解析 Brief。
 * @param {string} [modelOverride] 本次尝试使用的模型；缺省取 Brief.videoModel / env，供整镜降级链逐级指定。
 * @param {{dropFrame?: boolean}} [options] `dropFrame` 为 true 时不发送首帧，强制走文生视频
 *   （首帧图被上游内容审核拒绝后的退化路径，见设计文档 §6.2 第 5 条）。
 * @returns {Promise<{videoUrl: string, model: string, taskStatus: string|null}>} 成片地址与上游任务终态。
 * @throws {Error} 提交失败、轮询失败或任务到达失败终态时抛出。
 * @example await requestSceneVideoTask(scene, { ...brief, videoModel: "minimax-h3" }, "minimax-h3", { dropFrame: true });
 */
async function requestSceneVideoTask(scene, brief, modelOverride, { dropFrame = false } = {}) {
  if (getProviderMode() !== "real") return demoSceneVideo(scene, brief);
  const model = modelOverride || brief.videoModel || process.env.PROMO_VIDEO_MODEL;
  if (!model) throw new Error("未指定视频模型（Brief.videoModel / env PROMO_VIDEO_MODEL）");
  // 说明：动态视频与分镜、场景图必须同源。首帧被内容审核拒绝退化为文生时只改输入形态，
  // prompt 在首帧判定之前构造，因此两条路径天然携带同一份风格锚点。
  let prompt = `${stylePrompt(brief)}；${scene.visualPrompt || scene.subtitle || ""}`;
  if (brief.logoColor) prompt += `；主色 ${brief.logoColor}`;
  const canvas = resolveCanvas(brief.canvasPreset);
  const body = {
    model,
    prompt,
    n: 1,
    // 说明：minimax-h3 等渠道把 duration 设为必填（4~30 整数秒并按秒计费），seedance 系同样按该字段取值；
    // 缺失时上游直接失败 body.duration: Field required。场景时长是小数秒，向上取整后由 normalizeSceneVideo
    // 裁剪/补帧到权威时长，因此请求时长只会 ≥ 场景时长，不会丢帧。
    duration: videoRequestDurationSec(scene),
    aspect_ratio: canvas.aspectRatio,
    // 说明：minimax-h3 的生成请求拒绝 adaptive，必须显式给白名单比例（21:9/16:9/4:3/1:1/3:4/9:16）；
    // 画布预设比例恰好都落在白名单内，故与 aspect_ratio 同源。
    ratio: canvas.aspectRatio,
    width: canvas.width,
    height: canvas.height,
    size: `${canvas.width}x${canvas.height}`,
  };
  // 首帧来源：上游视频渠道自行下载该图片，只接受公网 http(s) URL。2026-09 实测：data: URL 被上游拒绝
  // （refusing to download from disallowed scheme 'data'），localhost/host.docker.internal 等本机地址同样不可达，
  // 因此本地标准化图片（scene.mediaPath）不得作为首帧输入，只用于预览与最终合成。
  // 图像渠道没给出公网 URL（例如只回 b64_json）时退化为文生视频，而不是让整条真实链路失败（FR-4.5）。
  // dropFrame：首帧图被上游内容审核拒绝后的退化路径——同一张图换渠道会被同样拒绝，只能改用纯文生（见设计文档 §6.2 第 5 条）。
  const frameRef = dropFrame ? null : (isPublicHttpUrl(scene.frameImageUrl) ? scene.frameImageUrl : (isPublicHttpUrl(scene.mediaUrl) ? scene.mediaUrl : null));
  if (frameRef) {
    body.image = frameRef;
  } else if (dropFrame) {
    console.warn(`[video] 第 ${scene.index ?? "?"} 镜去掉首帧退化为文生视频`);
  } else {
    console.warn(`[video] 第 ${scene.index ?? "?"} 镜没有可用的公网首帧 URL，退化为文生视频`);
  }
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
  if (videoUrl) return { videoUrl, model, taskStatus: null };
  // 异步任务：轮询直至完成。提交响应也可能是 new-api 包装形态 {code:"success", data:{id,status}}，
  // 先解包再取 id（unwrap 对非包装形态原样返回，数组形态 data.data[] 不会被守卫吞掉）。
  const submitted = unwrapVideoTask(data);
  const id = submitted?.id || submitted?.data?.[0]?.id || submitted?.task_id || submitted?.request_id;
  if (!id) throw new Error(`视频接口未返回 url 或任务 id：${JSON.stringify(data).slice(0, 200)}`);
  const deadline = Date.now() + Number(process.env.PROMO_VIDEO_TIMEOUT_MS ?? 600000);
  let lastErr = null;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, Number(process.env.PROMO_VIDEO_POLL_MS ?? 3000)));
    let best = null;
    // 说明：同一任务 id 在不同端点的信息完整度不同（见 videoTaskInfo），一轮内依次询问候选端点并择优；
    // 只有「公网可达成片地址 / 明确失败 / 成功终态但无地址」才算命中本轮 —— 只认首个 200 会拿到 /videos/{id} 的空壳响应，
    // 让权威端点里的 FAILURE 与 fail_reason 永远读不到（2026-09 真实验收轮询超时 >旧默认 180s 的根因）。
    // 同理，权威端点的 result_url 回环地址（localhost:3000，宿主机不可达）也不得提前命中，否则会遮蔽同响应 metadata.url
    // 里的公网签名地址，让已经出片的付费任务在下载阶段失败（2026-09-22 真实验收根因）。
    for (const p of VIDEO_POLL_PATHS(id)) {
      let candidate = null;
      try {
        candidate = await oneApiGet(p);
      } catch (e) {
        lastErr = e;
        if (e.status !== 404 && !/Invalid URL/i.test(String(e.message))) break; // 非路径问题停止尝试该轮
        continue;
      }
      const info = videoTaskInfo(candidate);
      if (!best || info.score > best.info.score) best = { raw: candidate, info };
      if (info.done) break;
    }
    if (!best) continue;
    // 说明：公网可达地址优先直接交付；回环/内网地址虽然也通过了形态校验，但宿主机下载必然失败
    // （实测 http://localhost:3000 → ECONNREFUSED），因此不允许它遮蔽同轮里明确的上游失败信息。
    if (best.info.urlPublic) return { videoUrl: best.info.url, model, taskStatus: best.info.status ?? null };
    if (best.info.failed) {
      // 说明：失败原因有字符串 fail_reason、对象 error{code,message}（minimax-h3 实测）、字符串 error
      // 三种形态，统一经 videoFailureReason 抽取，避免只看到 [object Object] 而丢失上游真实原因。
      throw new Error(`视频任务 ${id} 失败：${best.info.failReason || best.info.status}`);
    }
    if (best.info.url) {
      // 说明：保留旧行为——只剩非公网地址时仍然交付，由物化阶段的下载重试与错误信息给出真实原因，
      // 不在这里直接判失败（部分自建/内网存储部署确实走内网地址，本机不一定不可达）。
      console.warn(`[video] 任务 ${id} 只返回了非公网成片地址 ${best.info.url}，仍尝试物化`);
      return { videoUrl: best.info.url, model, taskStatus: best.info.status ?? null };
    }
    if (VIDEO_SUCCESS_STATUSES.includes(best.info.status)) {
      throw new Error(`视频任务 ${id} 完成但未返回 URL：${JSON.stringify(best.raw).slice(0, 200)}`);
    }
  }
  throw new Error(`视频任务 ${id} 轮询超时（>${Number(process.env.PROMO_VIDEO_TIMEOUT_MS ?? 600000) / 1000}s）${lastErr ? `，最近错误：${String(lastErr?.message || lastErr)}` : ""}`);
}

// new-api 任务查询包装解包：{code:"success", data:{status, result_url, fail_reason}} → 返回 data 层。
function unwrapVideoTask(raw) {
  // 说明：new-api 统一包装 {code:"success", data:{...}}，提交响应 data 只有 id、轮询响应 data 含
  // status/result_url/fail_reason，实测还存在 data 为「单元素数组」的形态；都解包，非包装形态原样返回。
  if (raw && raw.code && raw.data) {
    const d = raw.data;
    if (Array.isArray(d)) {
      if (d.length === 1 && d[0] && typeof d[0] === "object") return d[0];
    } else if (typeof d === "object" && ("id" in d || "status" in d || "state" in d || "result_url" in d || "fail_reason" in d || "error" in d || "metadata" in d)) {
      return d;
    }
  }
  return raw;
}

// 从视频接口响应中提取可用成片 URL，只接受可物化地址形态：兼容
//   顶层 { url | video_url | result_url }；data/output/results/videos 为数组（元素为 string 或 {url|video_url|content.url}）；
//   data/output 为对象 { url | video_url | content:{url} }；内容门控 {content:[{url}]} 等；
//   metadata.url（minimax-h3 成功响应的实际位置，2026-09 真机实测）。
// 说明：非可物化形态一律丢弃 —— 上游失败时会把错误文案填进 result_url（实测 `upstream returned unrecognized message`），不校验就会被当成产物地址去下载。
// 说明：必须先收齐全部候选再择优，不能按首次命中返回。new-api 的 /video/generations/{id} 会在 result_url 里回填容器内
//   回环地址 http://localhost:3000/v1/videos/{id}/content（宿主机 ECONNREFUSED，改写成宿主端口后仍被网关自身的私网下载
//   策略拒绝），同一响应 metadata.url 才是可直接下载的公网签名地址 https://ark-*.tos-*.volces.com/*.mp4；按首次命中会拿到
//   回环地址，让一个已经出片的付费任务在下载阶段白白失败（2026-09-22 真实验收根因）。
//   择优顺序：公网可达地址 > 其他可物化形态（data:/file:/不可公网直达的 http(s)），同级按出现顺序取先。
function extractVideoUrl(data) {
  if (!data) return null;
  const candidates = [];
  const push = (value) => {
    if (!isMediaUrl(value)) return;
    const hit = value.trim();
    if (!candidates.includes(hit)) candidates.push(hit);
  };
  function fromContent(content) {
    if (typeof content === "string") return push(content);
    if (Array.isArray(content)) {
      for (const item of content) {
        if (typeof item === "string") push(item);
        else fromObject(item);
      }
      return;
    }
    fromObject(content);
  }
  function fromObject(obj) {
    if (!obj || typeof obj !== "object") return;
    for (const key of ["url", "video_url", "result_url"]) push(obj[key]);
    // minimax-h3 成功响应把成片地址放在 metadata.url（顶层无 url 字段），漏读会被误判为「完成但未返回 URL」。
    if (obj.metadata && typeof obj.metadata === "object") {
      for (const key of ["url", "video_url"]) push(obj.metadata[key]);
    }
    if (obj.content) fromContent(obj.content);
  }
  fromObject(data);
  for (const nested of [data.data, data.results, data.videos, data.output]) {
    if (!nested) continue;
    if (Array.isArray(nested)) {
      for (const item of nested) {
        if (typeof item === "string") push(item);
        else fromObject(item);
      }
    } else if (typeof nested === "string") {
      push(nested);
    } else {
      fromObject(nested);
    }
  }
  const best = candidates.find((candidate) => isPublicHttpUrl(candidate)) || candidates[0] || null;
  // 说明：选中的公网地址与首个候选不一致，说明首个候选被网关回填成了内部地址；留一条可审计日志便于排障。
  if (best && candidates[0] !== best && /^https?:\/\//i.test(candidates[0])) {
    console.warn(`[video] 成片地址候选 ${candidates[0]} 不可公网直达，改用 ${best}`);
  }
  return best;
}

// DEMO：不真调视频接口 —— 沿用静态场景图（动态镜头在 real 模式由网关视频渠道产出）。
function demoSceneVideo(scene, brief) {
  return { videoUrl: null, kind: "video-stub", model: brief.videoModel || "demo-video", note: "DEMO：未调用视频接口，出片仍为静态图合成" };
}

// 物化重试上限：成片下载或 FFmpeg 归一化的瞬时失败只对同一 URL 重试，绝不触发新的付费生成任务。
const MEDIA_FINALIZE_MAX_ATTEMPTS = 3;

/**
 * 解析成片物化的最大尝试次数。
 *
 * 说明：HTTP 传输在 materializeMedia 内已有下载重试（PROMO_MEDIA_DOWNLOAD_ATTEMPTS）；
 * 这里额外包一层是为了覆盖 FFmpeg 归一化的瞬时失败（临时文件占用、IO 抖动），默认只需 2 次。
 *
 * @returns {number} 1~3 之间的尝试次数。
 * @example mediaFinalizeAttemptCount(); // 2
 */
function mediaFinalizeAttemptCount() {
  const raw = Number(process.env.PROMO_MEDIA_FINALIZE_ATTEMPTS ?? 2);
  if (!Number.isFinite(raw) || raw < 1) return 1;
  return Math.min(MEDIA_FINALIZE_MAX_ATTEMPTS, Math.floor(raw));
}

/**
 * 成片物化：失败只对同一成片 URL 重试，不重新提交生成任务。
 *
 * @param {{videoUrl: string, model: string, taskStatus: string|null}} task 生成阶段产出的任务信息。
 * @param {Record<string, any>} scene 目标场景。
 * @param {Record<string, any>} brief 已解析 Brief。
 * @param {{inputsWorkspace?: string, scenesWorkspace?: string}} [options] 受管目录。
 * @returns {Promise<{videoPath?: string, videoUrl: string|null, kind: string, model: string, _usage?: object}>} 标准化视频结果。
 * @throws {Error} 重试耗尽后抛出最后一次物化错误（信息含底层 cause）。
 * @example await finalizeSceneVideoWithRetry({ videoUrl, model, taskStatus: null }, scene, brief, options);
 */
async function finalizeSceneVideoWithRetry(task, scene, brief, options = {}) {
  const attempts = mediaFinalizeAttemptCount();
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await finalizeSceneVideo(task.videoUrl, scene, brief, task.model, options, task.taskStatus ?? undefined);
    } catch (error) {
      lastError = error;
      if (attempt >= attempts) break;
      const waitMs = Number(process.env.PROMO_MEDIA_DOWNLOAD_BACKOFF_MS ?? 1500) * attempt;
      console.warn(`[video] 第 ${scene.index ?? "?"} 镜成片物化第 ${attempt}/${attempts} 次失败（${error?.message}），${waitMs}ms 后对同一 URL 重试（不重新提交生成任务）`);
      await new Promise((r) => setTimeout(r, waitMs));
    }
  }
  throw lastError || new Error("成片物化失败");
}

// ───────────────────────── 4) TTS 配音 ─────────────────────────
function attachPartialUsage(error, usage) {
  const failure = error instanceof Error ? error : new Error(String(error));
  failure._usage = usage;
  return failure;
}

async function finalizeSceneVideo(videoUrl, scene, brief, model, options, taskStatus) {
  if (options.inputsWorkspace && options.scenesWorkspace) {
    const videoPath = await normalizeSceneVideo({
      source: videoUrl,
      inputsWorkspace: options.inputsWorkspace,
      scenesWorkspace: options.scenesWorkspace,
      canvasPreset: brief.canvasPreset,
      durationSec: Number(scene.durationSec),
    });
    scene.videoPath = videoPath;
    return {
      videoPath,
      videoUrl: pathToFileURL(videoPath).href,
      kind: "video",
      model,
      _usage: { videos: 1 },
      ...(taskStatus ? { taskStatus } : {}),
    };
  }
  return { videoUrl, kind: "video", model, _usage: { videos: 1 }, ...(taskStatus ? { taskStatus } : {}) };
}

// 主通道：OpenAI 兼容 /audio/speech，返回带容器的音频字节（mp3/wav 由上游决定）。
async function fetchPrimarySpeech(model, input, brief, openaiTts) {
  // response_format 是 OpenAI 专属字段：MiniMax speech 系上游只认自己的 output_format(hex|url)，带它会 406。
  // 仅在 OpenAI 原生系模型名（tts-1*/gpt-4o-mini-tts）时携带，其余（speech-* 等）不带，网关默认 mp3。
  const body = { model, input, voice: mapVoiceTone(brief.voiceTone), language: brief.language || "zh-CN" };
  if (openaiTts) body.response_format = "mp3";
  const audio = await oneApiPost("/audio/speech", body, { isBinary: true });
  // 网关成功返回即可能产生费用，调用方在成功后立刻计费，不依赖后续解码是否成功。
  if (!Buffer.isBuffer(audio) || audio.length === 0) throw new Error("TTS 返回空音频响应");
  return `data:audio/mpeg;base64,${audio.toString("base64")}`;
}

// 备用通道：Qwen-Omni 多模态流式语音。返回裸 PCM（24kHz/单声道/s16le），必须补 RIFF 头才能通过魔数与 ffprobe 校验。
async function fetchOmniSpeech(model, input, brief) {
  const events = await oneApiPostStream("/chat/completions", {
    model,
    messages: [
      { role: "system", content: "你是专业的中文配音演员。只朗读用户给出的台词原文，不添加任何解释、标点说明或额外语句。" },
      { role: "user", content: withGlobalLanguage(String(input), brief.language) },
    ],
    modalities: ["text", "audio"],
    audio: { voice: omniVoiceFor(brief.voiceTone), format: "pcm" },
    stream: true,
    // include_usage 让网关口径与 chat 通道一致，便于后续按 token 侧计费对账。
    stream_options: { include_usage: true },
  });
  const pcm = collectOmniAudio(events, { model, input });
  return `data:audio/wav;base64,${wrapPcmAsWav(pcm).toString("base64")}`;
}

// 逐句合成配音：主通道逐句往返，任一失败即整句重走备用通道；一旦备用通道成功，后续各句继续用它，
// 避免同一支成片中途换音色（音色由 voiceTone 映射，两条通道名称体系不同）。
async function synthesizeVoiceSegments({ lines, brief, workspace, model, fallbackModel, openaiTts, paidDurationsSec }) {
  const segmentPaths = [];
  const speechDurationsSec = [];
  let active = { kind: "primary", model };
  let fallbackNote = "";
  for (const input of lines) {
    let source;
    if (active.kind === "primary") {
      try {
        source = await fetchPrimarySpeech(model, input, brief, openaiTts);
      } catch (primaryError) {
        if (!fallbackModel) throw primaryError;
        // 主通道失败原因写进回退说明：额度不足这类外部状态无法在预检发现，失败必须可解释。
        fallbackNote = `主通道 ${model} 失败后改用备用通道 ${fallbackModel}：${primaryError?.message || primaryError}`;
        active = { kind: "fallback", model: fallbackModel, primaryError };
      }
    }
    if (active.kind === "fallback") {
      try {
        source = await fetchOmniSpeech(active.model, input, brief);
      } catch (fallbackError) {
        // 两条通道都失败时，错误必须同时给出两个模型 ID 与两条通道各自的最后一次原因，否则排障只能猜。
        const primaryReason = active.primaryError?.message || "未调用";
        throw new Error(`TTS 两条通道均失败。主通道 ${model}：${primaryReason}；备用通道 ${active.model}：${fallbackError?.message || fallbackError}`);
      }
    }
    paidDurationsSec.push(3);
    const segmentPath = await materializeMedia({ source, kind: "audio", workspace });
    const durationSec = await probeAudioDuration(segmentPath);
    segmentPaths.push(segmentPath);
    speechDurationsSec.push(durationSec);
    paidDurationsSec[paidDurationsSec.length - 1] = durationSec;
  }
  return { segmentPaths, speechDurationsSec, model: active.model, fallbackNote };
}

/**
 * 按确认脚本逐句生成真实配音，并用实测时长生成权威字幕时间轴。
 *
 * 主通道为 OpenAI 兼容 `/audio/speech`；逐句失败（额度 403 / 无渠道 / 5xx / 空音频）时切换到
 * 同一网关上的 Qwen-Omni 备用通道，并在成功的那一句起固定使用备用通道的音色。
 *
 * @param {{voiceover?: Array<{text?: string}>}} script 已确认脚本。
 * @param {Record<string, any>} brief 已解析 Brief，优先消费 ttsModel / ttsFallbackModel 与画布配置。
 * @param {{workspace?: string}} [options] `artifactPaths(runId).audio` 受管音频目录。
 * @returns {Promise<{voicePath?: string, voiceUrl: string|null, cues?: Array, srt: string, durationSec?: number, sceneDurationsMs?: number[], voiceTone: string, model: string, fallbackNote?: string, _usage?: object}>} 配音及权威时间轴。
 * @throws {Error} 真实模式缺少工作区、文本为空、两条通道都失败或音频不可解码时抛出。
 * @example await generateVoiceover(script, brief, { workspace: paths.audio });
 */
export async function generateVoiceover(script, brief, options = {}) {
  if (getProviderMode() !== "real") return demoVoiceover(script, brief);
  const model = brief.ttsModel || process.env.PROMO_TTS_MODEL || "speech-02-hd";
  const fallbackModel = brief.ttsFallbackModel || process.env.PROMO_TTS_FALLBACK_MODEL || "";
  const lines = (script?.voiceover || []).map((item) => String(item?.text ?? ""));
  if (lines.length === 0 || lines.some((line) => line.replace(/[\u0000-\u0020\u007F]/gu, "").length === 0)) {
    throw new Error("确认脚本的逐句旁白文本不能为空");
  }
  if (!options.workspace) throw new Error("真实配音必须提供受管 audio workspace");
  const openaiTts = /^(?:tts-|gpt-4o-mini-tts(?:$|-))/i.test(model);
  const paidDurationsSec = [];
  let synthesized;
  try {
    synthesized = await synthesizeVoiceSegments({
      lines,
      brief,
      workspace: options.workspace,
      model,
      fallbackModel,
      openaiTts,
      paidDurationsSec,
    });
  } catch (error) {
    throw withPartialTtsUsage(error, paidDurationsSec);
  }
  const { segmentPaths, speechDurationsSec, fallbackNote } = synthesized;
  const usedModel = synthesized.model;
  let voicePath;
  try {
    voicePath = await concatenateVoiceSegments(segmentPaths, { workspace: options.workspace });
  } catch (error) {
    throw withPartialTtsUsage(error, paidDurationsSec);
  }
  const speechSeconds = speechDurationsSec.reduce((sum, value) => sum + value, 0);
  const usage = { minutes: speechSeconds / 60, audioSeconds: speechSeconds, requests: lines.length };
  try {
    const concatenatedDuration = await probeAudioDuration(voicePath);
    const canvas = resolveCanvas(brief.canvasPreset);
    const timeline = buildVoiceTimeline(lines, speechDurationsSec, { maxCharsPerLine: canvas.subtitle.maxCharsPerLine });
    if (Math.abs(concatenatedDuration - timeline.durationSec) > 0.08) {
      throw new Error(`拼接语音时长与权威时间轴不一致：${concatenatedDuration}s / ${timeline.durationSec}s`);
    }
    const srt = formatSrt(timeline.cues, timeline.durationSec);
    return {
      voicePath,
      voiceUrl: pathToFileURL(voicePath).href,
      cues: timeline.cues,
      srt,
      durationSec: timeline.durationSec,
      sceneDurationsMs: timeline.sceneDurationsMs,
      voiceTone: brief.voiceTone || "男声",
      model: usedModel,
      ...(fallbackNote ? { fallbackNote } : {}),
      _usage: usage,
    };
  } catch (error) {
    throw attachPartialUsage(error, usage);
  }
}

// 部分计费：主/备通道已成功返回音频的句子按实测秒数计入，失败本身不掩盖已发生费用。
function withPartialTtsUsage(error, paidDurationsSec) {
  if (paidDurationsSec.length === 0) return error;
  const paidSeconds = paidDurationsSec.reduce((sum, value) => sum + value, 0);
  return attachPartialUsage(error, {
    minutes: paidSeconds / 60,
    audioSeconds: paidSeconds,
    requests: paidDurationsSec.length,
  });
}

function demoVoiceover(script, brief) {
  const lines = script?.voiceover || [];
  if (lines.length === 0) throw new Error("DEMO 确认脚本旁白不能为空");
  const totalDurationSec = Number(brief.durationSec || 30);
  if (!Number.isFinite(totalDurationSec) || totalDurationSec <= 0) throw new Error("DEMO 目标时长无效");
  const totalDurationMs = Math.round(totalDurationSec * 1000);
  const startsMs = lines.map((line, index) => parseTimecodeMs(line.timecode, index));
  if (startsMs[0] !== 0) throw new Error("DEMO 第一条旁白 timecode 必须从 00:00:00.000 开始");
  const speechDurationsSec = startsMs.map((startMs, index) => {
    const endMs = index < startsMs.length - 1 ? startsMs[index + 1] : totalDurationMs;
    const intervalMs = endMs - startMs;
    const speechMs = intervalMs - (index < startsMs.length - 1 ? MEDIA_LIMITS.voiceGapMs : 0);
    if (intervalMs <= 0 || speechMs <= 0) throw new Error(`DEMO 第 ${index + 1} 条旁白 timecode 非单调或超出目标时长`);
    return speechMs / 1000;
  });
  const timeline = buildVoiceTimeline(lines.map((line) => line.text), speechDurationsSec, {
    maxCharsPerLine: resolveCanvas(brief.canvasPreset).subtitle.maxCharsPerLine,
  });
  if (Math.round(timeline.durationSec * 1000) !== totalDurationMs) throw new Error("DEMO 时间轴总时长与目标时长不一致");
  const srt = formatSrt(timeline.cues, timeline.durationSec);
  return {
    voiceUrl: null,
    cues: timeline.cues,
    srt,
    durationSec: timeline.durationSec,
    sceneDurationsMs: timeline.sceneDurationsMs,
    voiceTone: brief.voiceTone || "男声",
    model: "demo-tts",
  };
}

function parseTimecodeMs(value, index) {
  const match = /^(\d{2,}):(\d{2}):(\d{2})[.,](\d{3})$/u.exec(String(value || ""));
  if (!match) throw new Error(`DEMO 第 ${index + 1} 条旁白 timecode 格式无效`);
  const [, hours, minutes, seconds, milliseconds] = match;
  if (Number(minutes) >= 60 || Number(seconds) >= 60) throw new Error(`DEMO 第 ${index + 1} 条旁白 timecode 格式无效`);
  return Number(hours) * 3_600_000 + Number(minutes) * 60_000 + Number(seconds) * 1000 + Number(milliseconds);
}

// ───────────────────────── 5) 音乐（Mureka 协议桥：mureka-song 提交 + mureka-query 轮询） ─────────────────────────
/**
 * 通过 one-api 桥调用一次 chat/completions，并把 content（JSON 字符串）解析为对象。
 *
 * 说明：Mureka 是非 OpenAI 协议（提交任务 + 按 taskId 轮询），由 mingstar-model-bridge 以
 * chat/completions 形态桥接；content 承载业务 JSON。此处统一解包，避免每个调用点重复解析。
 * @param {string} model 桥暴露的模型名（mureka-song / mureka-query）。
 * @param {Record<string, any>} payload 业务负载（序列化后放入 user content）。
 * @param {{timeoutMs?: number}} [options] 单次请求超时。
 * @returns {Promise<Record<string, any>>} 解析后的业务对象。
 * @throws {Error} 响应缺少 content 或 content 不是合法 JSON 时抛出。
 * @example await chatCompletionJson("mureka-query", { taskId, kind });
 */
async function chatCompletionJson(model, payload, { timeoutMs = 120000 } = {}) {
  const data = await oneApiPost(
    "/chat/completions",
    { model, messages: [{ role: "user", content: JSON.stringify(payload) }] },
    { timeoutMs },
  );
  const content = data?.choices?.[0]?.message?.content;
  if (typeof content !== "string" || content.trim() === "") throw new Error(`one-api 桥响应缺少 content（model=${model}）`);
  const parsed = parseJSONSafe(content);
  if (!parsed || typeof parsed !== "object" || Object.keys(parsed).length === 0) {
    throw new Error(`one-api 桥返回的 content 不是合法 JSON（model=${model}）`);
  }
  return parsed;
}

// 配乐桥调用的瞬时故障重试上限：提交与轮询各自算一次调用，默认只额外重试 1 次（共 2 次）。
const MUSIC_MAX_ATTEMPTS = 3;

/**
 * 解析配乐桥调用的最大尝试次数。
 *
 * 说明：Mureka 桥把上游网络故障统一包成 502，实测同一请求重发即可恢复（2026-09 真实验收在
 * voiceover 成功后、generateScenes 之前被一次 UND_ERR_SOCKET 打断）。上限固定为 3，避免配置错误
 * 把一次 run 的费用放大到不可控。
 *
 * @returns {number} 1~3 之间的尝试次数。
 * @example musicAttemptCount(); // 2
 */
function musicAttemptCount() {
  const raw = Number(process.env.PROMO_MUSIC_ATTEMPTS ?? 2);
  if (!Number.isFinite(raw) || raw < 1) return 1;
  return Math.min(MUSIC_MAX_ATTEMPTS, Math.floor(raw));
}

/**
 * 判断配乐桥错误是否为可重试的瞬时故障。
 *
 * 说明：桥把上游故障统一压成 HTTP 502 + error.code，HTTP 状态本身无法区分「上游抖动」与
 * 「上游拒绝」，因此必须同时看 status 与错误文案。契约类错误（4xx、缺少 taskId、content 非 JSON）
 * 重发同样失败，必须立即抛出。
 *
 * @param {unknown} error 捕获到的错误。
 * @param {{submissionSensitive?: boolean}} [options] 该调用是否会创建上游付费任务。
 *   提交路径只重试「确定未到达上游」的故障（bridge_upstream_unavailable / 连接层错误），
 *   受理结果未知与客户端超时中止一律不重试；轮询是只读查询，可放宽到 5xx 与网络类文案。
 * @returns {boolean} 可重试时返回 true。
 * @example isTransientMusicError(new Error("one-api /chat/completions 502: bridge_upstream_unavailable")); // true
 */
function isTransientMusicError(error, { submissionSensitive = false } = {}) {
  const message = String(error?.message || error || "");
  if (submissionSensitive) {
    // 说明：提交会真的创建上游付费任务。桥用两种码区分故障位置：bridge_upstream_unavailable 表示连接
    // 从未到达上游（重发安全）；bridge_submission_unknown 表示受理结果未知。客户端自身的超时中止同样
    // 无法判定上游是否受理，与「受理结果未知」等价处理，一律不重试。
    if (/submission_unknown|受理结果未知|abort|timeout|超时/i.test(message)) return false;
    return /bridge_upstream_unavailable|网络暂时不可用|UND_ERR_CONNECT_TIMEOUT|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|EHOSTUNREACH|ENETUNREACH|ERR_INVALID_URL/i.test(message);
  }
  const status = Number(error?.status);
  if (Number.isFinite(status) && status > 0) return status >= 500 || status === 408 || status === 429;
  return /bridge_upstream_unavailable|bridge_upstream_error|UND_ERR_|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE|EAI_AGAIN|socket hang up|fetch failed|网络暂时不可用|请求失败/i.test(message);
}

/**
 * 带瞬时故障重试的桥调用：重试粒度是「一次 chat/completions」，绝不跨越提交边界。
 *
 * 说明：只能包住单次调用。若把 generateMusic 的整个流程（含轮询等待、音频下载与物化）包进重试，
 * 下游失败会重新提交一次已付费的配乐任务 —— 与视频那次「下载抖动放大成两次付费生成」是同一类缺陷。
 *
 * @param {string} model 桥暴露的模型名（mureka-song / mureka-query）。
 * @param {Record<string, any>} payload 业务负载（序列化后放入 user content）。
 * @param {{timeoutMs?: number, submissionSensitive?: boolean}} [options] 单次请求超时与提交敏感标记。
 * @returns {Promise<Record<string, any>>} 解析后的业务对象。
 * @throws {Error} 重试耗尽或遇到契约类错误时抛出最后一次错误。
 * @example await chatCompletionJsonWithRetry("mureka-query", { taskId, kind });
 */
async function chatCompletionJsonWithRetry(model, payload, { timeoutMs = 120000, submissionSensitive = false } = {}) {
  const attempts = musicAttemptCount();
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await chatCompletionJson(model, payload, { timeoutMs });
    } catch (error) {
      lastError = error;
      if (attempt >= attempts || !isTransientMusicError(error, { submissionSensitive })) throw error;
      // 说明：按尝试次数线性退避，给上游故障窗口留出恢复时间；最后一次不再等待。
      const waitMs = Number(process.env.PROMO_MUSIC_RETRY_BACKOFF_MS ?? 2000) * attempt;
      console.warn(`[music] ${model} 第 ${attempt}/${attempts} 次调用失败（${error?.message}），${waitMs}ms 后重试`);
      await new Promise((r) => setTimeout(r, waitMs));
    }
  }
  throw lastError || new Error("配乐桥调用失败");
}

/**
 * 生成配乐并物化、探测真实音频文件；本阶段不执行最终混音。
 *
 * 说明：配乐固定走 Mureka 协议桥（mureka-song 提交 → mureka-query 轮询取 audioUrl）。
 * 网关是 new-api，不含 OpenAI /audio/music 路由，直连该端点必然 404；桥与 ai-core 共用
 * 同一 one-api 渠道与同一密钥，因此复用桥是唯一可用且与平台一致的链路。
 * @param {Record<string, any>} brief 已解析 Brief，优先消费 musicModel。
 * @param {Array} storyboard 分镜上下文。
 * @param {{workspace?: string}} [options] `artifactPaths(runId).audio` 受管音频目录。
 * @returns {Promise<{musicPath?: string, musicUrl: string|null, durationSec?: number, mood: string, model: string, _usage?: object}>} 配乐素材。
 * @throws {Error} 真实模式提交/轮询失败、超时或音频不可物化时抛出。
 * @example await generateMusic(brief, scenes, { workspace: paths.audio });
 */
export async function generateMusic(brief, storyboard, options = {}) {
  if (getProviderMode() !== "real") return demoMusic(brief);
  if (!options.workspace) throw new Error("真实配乐必须提供受管 audio workspace");
  const model = brief.musicModel || process.env.PROMO_MUSIC_MODEL || MUSIC_SUBMIT_MODEL;
  const prompt = `背景音乐：${(brief.tones || ["专业"]).join("/")}风格，匹配宣传片情绪曲线`;
  const submitTimeoutMs = Number(process.env.PROMO_MUSIC_SUBMIT_TIMEOUT_MS ?? 60000);
  const pollMs = Number(process.env.PROMO_MUSIC_POLL_MS ?? 5000);
  const timeoutMs = Number(process.env.PROMO_MUSIC_TIMEOUT_MS ?? 300000);
  let musicPath;
  let durationSec;
  try {
    // 说明：提交会创建上游付费任务，故标记 submissionSensitive：受理结果未知（bridge_submission_unknown）不重试。
    const submitted = await chatCompletionJsonWithRetry(model, { prompt, mode: "instrumental" }, { timeoutMs: submitTimeoutMs, submissionSensitive: true });
    const taskId = String(submitted?.taskId || "").trim();
    if (!taskId) throw new Error("配乐桥提交响应缺少 taskId");
    const kind = submitted?.kind === "song" ? "song" : "instrumental";
    const deadline = Date.now() + timeoutMs;
    let audioUrl = null;
    for (;;) {
      // 说明：轮询是只读查询，重试零费用，可安全对瞬时故障重发。
      const task = await chatCompletionJsonWithRetry(MUSIC_QUERY_MODEL, { taskId, kind });
      const status = String(task?.status || "").toLowerCase();
      if (status === "succeeded") {
        audioUrl = String(task?.audioUrl || "").trim() || null;
        if (!audioUrl) throw new Error("配乐任务成功但未返回音频地址");
        break;
      }
      if (["failed", "cancelled", "canceled", "timeouted", "error"].includes(status)) {
        throw new Error(`配乐任务失败：${task?.errorMessage || status}`);
      }
      if (Date.now() >= deadline) throw new Error(`配乐任务轮询超时（>${timeoutMs / 1000}s）`);
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
    musicPath = await materializeMedia({ source: audioUrl, kind: "audio", workspace: options.workspace });
    durationSec = await probeAudioDuration(musicPath);
  } catch (error) {
    throw attachPartialUsage(error, { tracks: 1 });
  }
  return {
    musicPath,
    musicUrl: pathToFileURL(musicPath).href,
    durationSec,
    mood: (brief.tones || ["专业"]).join("/"),
    model,
    _usage: { tracks: 1, audioSeconds: durationSec },
  };
}

function demoMusic(brief) {
  return { musicUrl: null, mood: (brief.tones || ["专业"]).join("/"), model: "demo-mureka" };
}

// ───────────────────────── 6) 成片合成（服务端 FFmpeg，硬字幕 + 配音 + 配乐） ─────────────────────────
// REAL：必须产出持久化 final.mp4 / subtitles.srt / poster.jpg / manifest.json，任一缺失或校验失败即抛错，
//       不再有"分镜包降级"这一成功路径；失败由工作流边界统一置 run=failed。
// DEMO：返回带 DEMO 标记的分镜故事板，页面据此明确区分为演示结果。

async function resolveSubtitleFont(font) {
  const knownPath = configuredFontPath(font);
  if (knownPath) return knownPath;
  return resolveFontFile(font);
}

async function resolveCompositeFont() {
  const configured = String(process.env.PROMO_SUBTITLE_FONT || "Microsoft YaHei").trim();
  if (!configured) throw new Error("真实合成缺少中文字幕字体配置 PROMO_SUBTITLE_FONT");
  let fontPath;
  try {
    fontPath = await resolveSubtitleFont(configured);
  } catch (error) {
    throw new Error(`真实合成无法定位中文字幕字体 ${configured}：${error?.message || error}`, { cause: error });
  }
  if (!fs.existsSync(fontPath)) throw new Error(`真实合成的中文字幕字体文件不存在：${path.basename(fontPath)}`);
  if (!fontSupportsChinese(fontPath)) throw new Error("真实合成的中文字幕字体缺少中文字形（cmap 校验未通过）");
  return { fontPath, fontName: configured };
}

function persistentPublicUrl(runId, filePath, route) {
  if (!fs.existsSync(filePath)) throw new Error(`真实合成产物缺失：${path.basename(filePath)}`);
  return route ? `/api/runs/${runId}/${route}` : pathToFileURL(filePath).href;
}

/**
 * 合成成片。REAL 模式产出带配音、配乐与中文硬字幕的持久化 MP4 及字幕、封面、manifest。
 *
 * @param {Array<Record<string, any>>} scenes 已标准化且含 `videoPath`/`durationSec` 的分镜。
 * @param {Record<string, any>} voice 逐句配音与权威时间轴（`voicePath`/`voiceUrl`/`cues`/`durationSec`）。
 * @param {Record<string, any>} music 配乐（`musicPath`/`musicUrl`）。
 * @param {Record<string, any>} brief 已解析 Brief。
 * @param {{paths?: ReturnType<typeof import("../media/artifacts.js").artifactPaths>, models?: Record<string, unknown>}} [options]
 *        `artifactPaths(runId)` 返回的受管产物目录；REAL 模式必填。
 * @returns {Promise<{videoUrl: string|null, poster: string|null, storyboardGallery: Array, srt: string, note: string, model: string, artifacts?: object, artifactManifest?: object, validated?: boolean, _usage?: object}>} 合成结果。
 * @throws {Error} REAL 模式下任一输入、滤镜、字体或校验缺失时抛出，不再降级。
 * @example await composite(scenes, voice, music, brief, { paths: artifactPaths(runId) });
 */
export async function composite(scenes, voice, music, brief, options = {}) {
  if (getProviderMode() !== "real") return demoComposite(scenes, voice, music, brief);
  const gallery = scenes.map((s) => ({ index: s.index, mediaUrl: s.mediaUrl, subtitle: s.subtitle }));
  const paths = options.paths;
  if (!paths) throw new Error("真实合成必须提供 artifactPaths(runId) 返回的受管产物目录");
  const ffmpeg = process.env.PROMO_FFMPEG_BIN;
  if (!ffmpeg) throw new Error("真实合成缺少 FFmpeg 配置（PROMO_FFMPEG_BIN）");
  await assertSubtitleFilters(ffmpeg);
  const missingVideo = scenes.filter((s) => typeof s.videoPath !== "string" || s.videoPath === "");
  if (missingVideo.length > 0) {
    throw new Error(`真实合成要求每镜都有标准化动态片段，缺失镜号：${missingVideo.map((s) => s.index ?? "?").join("、")}`);
  }
  const { fontPath, fontName } = await resolveCompositeFont();
  const result = await composeFinalVideo({
    scenes,
    voice,
    music,
    paths,
    canvasPreset: brief?.canvasPreset,
    fontPath,
    fontFamily: fontName,
    // 说明：manifest 是成品的唯一权威记录，风格必须落盘才能核对「成品画风 == 简报风格」。
    style: styleManifest(brief),
    models: {
      video: brief?.videoModel || null,
      tts: voice?.model || null,
      music: music?.model || null,
      image: brief?.imageModel || null,
      ...(options.models || {}),
    },
  });
  const runId = path.basename(paths.runRoot);
  return {
    videoUrl: pathToFileURL(result.finalVideoPath).href,
    poster: pathToFileURL(result.posterPath).href,
    storyboardGallery: gallery,
    srt: result.srt,
    note: "已合成为 MP4（服务端 FFmpeg，含配音、配乐与中文硬字幕）。",
    model: "ffmpeg",
    validated: true,
    artifacts: {
      finalVideo: persistentPublicUrl(runId, result.finalVideoPath),
      subtitles: `/api/runs/${runId}/artifacts/subtitles`,
      poster: `/api/runs/${runId}/artifacts/poster`,
    },
    artifactManifest: result.manifest,
    _usage: { videos: 1 },
  };
}

function demoComposite(scenes, voice, music, brief) {
  return {
    videoUrl: null,
    poster: scenes[0]?.mediaUrl || null,
    storyboardGallery: scenes.map((s) => ({ index: s.index, mediaUrl: s.mediaUrl, subtitle: s.subtitle })),
    srt: voice?.srt || "",
    note: "DEMO/降级模式：未接入真实合成服务，以下为分镜故事板（生产环境将合成为 MP4）。",
    model: "demo-composite",
  };
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
