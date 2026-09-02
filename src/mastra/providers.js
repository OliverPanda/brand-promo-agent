// Provider 抽象层：所有外部能力（LLM / 图像视频 / TTS / 音乐 / 合成）均经此适配。
// 默认 DEMO 模式：完全离线、确定性的占位生成，无需任何外部密钥即可端到端运行。
// 生产模式：注入对应环境变量后，自动切换到真实供应商（one-api / MingStar ai-core）。
//
// 切换只需实现对应 Provider 接口并设置环境变量，【工作流代码不变】。

import { encodeSVG } from "./svg.js";

// ───────────────────────── 环境判定 ─────────────────────────
const ENV = process.env;
const hasLLM = !!(ENV.MINGSTAR_LLM_BASE_URL || ENV.OPENAI_API_KEY);
const hasMedia = !!(ENV.MINGSTAR_AI_CORE_URL);
const hasTTS = !!(ENV.MINGSTAR_TTS_URL || ENV.MINGSTAR_LLM_BASE_URL);
const hasMusic = !!(ENV.MINGSTAR_MUSIC_URL || ENV.MINGSTAR_LLM_BASE_URL);

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

// ───────────────────────── 1) LLM：脚本生成 ─────────────────────────
export async function generateScript(brief) {
  if (!hasLLM) return demoScript(brief);
  // 生产：POST {MINGSTAR_LLM_BASE_URL}/chat/completions，model = MINGSTAR_LLM_MODEL（默认 deepseek-v4-flash）
  // 见 ADR-001：经 one-api 统一路由。下面为真实调用骨架（本环境未注入密钥，不会走到）。
  throw new Error("real LLM provider not wired in demo runtime");
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
  };
}

// ───────────────────────── 2) LLM：分镜生成 ─────────────────────────
export async function generateStoryboard(brief, script) {
  if (!hasLLM) return demoStoryboard(brief, script);
  throw new Error("real LLM provider not wired in demo runtime");
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
  if (!hasMedia) return demoSceneMedia(scene, brief);
  // 生产：POST {MINGSTAR_AI_CORE_URL}/api/v1/ai/... （Seedream 图生图 / 视频生成）
  throw new Error("real media provider not wired in demo runtime");
}

function demoSceneMedia(scene, brief) {
  const [c1, c2] = paletteFor(brief.tones);
  const svg = buildPosterSVG(scene, brief, c1, c2);
  return { mediaUrl: encodeSVG(svg), kind: "image", model: "demo-seedream" };
}

// ───────────────────────── 4) TTS 配音 ─────────────────────────
export async function generateVoiceover(script, brief) {
  if (!hasTTS) return demoVoiceover(script, brief);
  throw new Error("real TTS provider not wired in demo runtime");
}

function demoVoiceover(script, brief) {
  const srt = (script?.voiceover || [])
    .map((v, i) => `${i + 1}\n${v.timecode} --> ${fmtTC((i + 1) * 3)}\n${v.text}\n`)
    .join("\n");
  return { voiceUrl: null, srt, voiceTone: brief.voiceTone || "男声", model: "demo-tts" };
}

// ───────────────────────── 5) 音乐 ─────────────────────────
export async function generateMusic(brief, storyboard) {
  if (!hasMusic) return demoMusic(brief);
  throw new Error("real music provider not wired in demo runtime");
}

function demoMusic(brief) {
  return { musicUrl: null, mood: (brief.tones || ["专业"]).join("/"), model: "demo-mureka" };
}

// ───────────────────────── 6) 合成 ─────────────────────────
export async function composite(scenes, voice, music, brief) {
  if (!hasMedia) return demoComposite(scenes, voice, music, brief);
  throw new Error("real composite provider not wired in demo runtime");
}

function demoComposite(scenes, voice, music, brief) {
  // 真实场景：服务端 FFmpeg / MingStar 合成服务将素材+配音+配乐合为 MP4。
  // DEMO：返回可下载的分镜包描述 + 封面，前端以「分镜轮播」模拟播放。
  const poster = scenes[0]?.mediaUrl || null;
  return {
    videoUrl: null, // 生产环境回填 MP4 直链
    poster,
    storyboardGallery: scenes.map((s) => ({ index: s.index, mediaUrl: s.mediaUrl, subtitle: s.subtitle })),
    srt: voice?.srt || "",
    note: "DEMO 模式：未接入真实合成服务，以下为分镜故事板（生产环境将合成为 MP4）。",
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
