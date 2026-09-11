// 网关模型清单（用户诉求：填供应商地址 → 拿到该网关真实可用的模型，含视频渠道）。
// 设计：
//   - GET {base}/models（OpenAI 兼容），Bearer 认证，5s 超时，60s TTL 缓存；?refresh=1 强制刷新。
//   - 分类优先取条目自带 type 字段（new-api 部分版本返回 type=llm/image/tts/videogeneration…），
//     缺省按模型 id 关键词回退分类：video > audio(tts/music) > image > llm。
//   - 网关不可达 / 未配置：由调用方（server.js）决定回落策略 —— DEMO 给占位候选，real 报错不误导。
import { getEffectiveOneApiBase, getEffectiveOneApiKey } from "./runtime-config.js";

// ── 分类（纯函数，便于测试） ──
const TYPE_MAP = {
  llm: "llm",
  chat: "llm",
  text: "llm",
  language: "llm",
  image: "image",
  images: "image",
  img: "image",
  t2i: "image",
  "text-to-image": "image",
  audio: "audio",
  tts: "audio",
  music: "audio",
  voice: "audio",
  video: "video",
  videos: "video",
  videogeneration: "video",
  "video-generation": "video",
  t2v: "video",
  i2v: "video",
  "text-to-video": "video",
  "image-to-video": "video",
};

const VIDEO_RE = /kling|veo|seedance|runway|cogvideox|cogvideo|wan[0-9]|hunyuan[-_]?video|luma|pika|dreamina|pixverse|vividi|hailuo|mochi|sora|minimax[-_]?video|doubao[-_]?video|即梦|可灵|海螺/i;
const AUDIO_RE = /\b(tts|speech|voice|audio|music)\b|mureka|suno|iceberg|elevenlabs|bark|dictvoice|minimax[-_]?audio|doubao[-_]?tts|chatts/i;
const IMAGE_RE = /seedream|stable[-_]?diffusion|\bsd3\b|dall[-_]?e|dall|flux|midjourney|\bmj[-_]?|gpt[-_]?image|\bimage\b|wanx|tongyi[-_]?image|doubao[-_]?image|kolors|nano[-_]?banana|可图/i;
// 视频「子能力」API 黑名单：与视频生成本体同家族的图像/语音/特效/口型/运动控制/元素编辑/检测/角色
// 等子接口（new-api 聚合渠道按厂商全套展开，同名子 API 会被 VIDEO_RE 误收）。命中后回落
// audio/image/llm 真实归类（或 llm 兜底），确保 video 类只保留「能直接出动态片」的生成本体。
// 注：名单按实测网关清单维护（2026-09，new-api v0.13.2）；新增同族子 API 按形如
// `kling-<image|tts|effects|lip-sync|...>` 的模式自增，不必穷举。
const VIDEO_SUB_RE = /kling-(?:image|multi-image2image|kolors|tts|text-to-audio|video-to-audio|voices-list|presets-|lip-sync|advanced-lip-sync|effects|identify-face|meta-human|custom-|video-extend|video-motion-control|video-multi-)|runway-(?:act_|aleph)|sora[_-](?:image|characters)|wan[0-9]\.[0-9][_-](?:animate|s2v-detect)|veo[0-9a-z.-]*components|pixverse-character/i;

function classifyByKeywords(id) {
  const s = String(id);
  // 视频关键词命中但属「子能力 API」→ 不判 video，落到 audio/image/llm 真实归类
  if (VIDEO_RE.test(s) && !VIDEO_SUB_RE.test(s)) return "video";
  if (AUDIO_RE.test(s)) return "audio";
  if (IMAGE_RE.test(s)) return "image";
  return "llm"; // 兜底归文本模型
}

export function classifyModelId(id, type) {
  const t = type ? TYPE_MAP[String(type).toLowerCase()] : undefined;
  return t || classifyByKeywords(id);
}

// 输入 /models 的 data[]（每项 {id, type?, owned_by?…}）→ { llm, image, audio, video }（各自保序去重）。
export function classifyRemoteModels(data = []) {
  const out = { llm: [], image: [], audio: [], video: [] };
  for (const it of data) {
    const id = it?.id;
    if (!id) continue;
    const cat = classifyModelId(id, it?.type);
    if (!out[cat].includes(id)) out[cat].push(id);
  }
  return out;
}

// ── 网关拉取（TTL 缓存 + 强刷） ──
const TTL_MS = 60_000;
let cache = { at: 0, result: null };

export async function fetchRemoteModels({ refresh = false } = {}) {
  const base = getEffectiveOneApiBase();
  const key = getEffectiveOneApiKey();
  if (!base) throw new Error("未配置供应商地址：请在页面保存或设置 PROMO_ONEAPI_BASE_URL");
  if (!key) throw new Error("未配置 API 密钥：请在页面「模型与服务」保存 API Key，或设置 PROMO_ONEAPI_API_KEY 后重试");
  const now = Date.now();
  if (!refresh && cache.result && now - cache.at < TTL_MS) return cache.result;
  const url = `${base.replace(/\/$/, "")}/models`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), Number(process.env.PROMO_MODELS_TIMEOUT_MS ?? 5000));
  let res;
  try {
    res = await fetch(url, { headers: { Authorization: `Bearer ${key}` }, signal: ctrl.signal });
  } catch (e) {
    clearTimeout(timer);
    throw new Error(`网关不可达 ${url}：${e?.message || e}`);
  }
  clearTimeout(timer);
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    if (res.status === 401 && /登录已过期|login expired|unauthorized|invalid token/i.test(txt)) {
      throw new Error(/invalid token/i.test(txt)
        ? "New API 拒绝了当前 API Key：请在该 New API 实例重新创建或复制有效令牌，再回到页面保存"
        : "远程地址返回网页登录 401：请填 OpenAI 兼容中转 API 地址（通常以 /v1 结尾），不要填网页前端地址；网页登录会话不能替代 API Key");
    }
    throw new Error(`网关 /models ${res.status}：${txt.slice(0, 200)}`);
  }
  const json = await res.json();
  const byType = classifyRemoteModels(json?.data || []);
  const result = { fetchedAt: now, byType, raw: (json?.data || []).map((m) => ({ id: m.id, type: m.type, owned_by: m.owned_by })) };
  cache = { at: now, result };
  return result;
}

// DEMO 模式占位候选：仅用于「声明路由」演示（不产生真实调用）。
// real 模式若网关不可达不应返回占位（会误导用户选到不存在的渠道 id），由调用方置空并提示。
export function demoVideoChoices() {
  return ["kling-v1-6", "doubao-seedance-1-0", "veo-3", "hailuo-02"];
}
