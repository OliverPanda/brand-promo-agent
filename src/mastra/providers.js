// Provider 抽象层：所有外部能力（LLM / 图像 / TTS / 音乐 / 合成）均经此适配。
// 默认 DEMO 模式：完全离线、确定性的占位生成，无需任何外部密钥即可端到端运行。
// 生产模式（PROMO_PROVIDER_MODE=real）：经 one-api（OpenAI 兼容统一网关）调用真实能力，
//   图像走 /v1/images/generations（Seedream 等），TTS 走 /v1/audio/speech，音乐走 Mureka 桥；
//   合成走服务端 FFmpeg（PROMO_FFMPEG_BIN）。每个真实能力回传 _usage 供成本归集。
//
// 切换只需设置环境变量，【工作流代码不变】。本文件不含网络调用时机之外的业务逻辑。

import { encodeSVG } from "./svg.js";

// ───────────────────────── 模式判定 ─────────────────────────
// 仅在显式 PROMO_PROVIDER_MODE=real 时启用真实 Provider；其余一律 DEMO（安全默认，零外部依赖）。
export function getProviderMode() {
  return process.env.PROMO_PROVIDER_MODE === "real" ? "real" : "demo";
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
async function oneApiPost(path, body, { isBinary = false } = {}) {
  const base = process.env.PROMO_ONEAPI_BASE_URL || process.env.MINGSTAR_LLM_BASE_URL;
  const key = process.env.PROMO_ONEAPI_API_KEY || process.env.OPENAI_API_KEY;
  if (!base || !key) throw new Error("one-api 未配置：请设置 PROMO_ONEAPI_BASE_URL / PROMO_ONEAPI_API_KEY");
  const url = base.replace(/\/$/, "") + path;
  const res = await (globalThis.fetch || fetch)(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`one-api ${path} ${res.status}: ${txt.slice(0, 300)}`);
  }
  if (isBinary) return Buffer.from(await res.arrayBuffer());
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
  if (t.includes("女")) return "female";
  if (t.includes("沉稳") || t.includes("男")) return "male";
  if (t.includes("活泼")) return "young";
  return "male";
}

function langInstruction(lang) {
  switch (lang) {
    case "zh-TW":
      return "输出使用繁体中文。";
    case "en":
      return "Output in English.";
    case "ja":
      return "出力は日本語で。";
    case "ko":
      return "출력은 한국어로.";
    default:
      return "输出使用简体中文。";
  }
}

// ───────────────────────── 1) LLM：脚本生成 ─────────────────────────
export async function generateScript(brief) {
  if (getProviderMode() !== "real") return demoScript(brief);
  const model = process.env.PROMO_LLM_MODEL || "deepseek-v4-flash";
  const sys = "你是资深品牌文案，依据品牌简报产出宣传片脚本，严格只输出 JSON（不含解释），结构：{title, voiceover:[{timecode,text}], structure:[], moodCurve:[]}。";
  const user =
    `品牌：${brief.brandName}\n产品：${brief.productName}\n核心卖点：${brief.coreSellingPoint}\n` +
    `受众：${(brief.audience || []).join("、")}\n调性：${(brief.tones || []).join("、")}\n` +
    `核心信息：${(brief.keyMessages || []).join("；")}\n时长：${brief.durationSec}s\n` +
    `配音音色：${brief.voiceTone}\n${langInstruction(brief.language)}\n` +
    `voiceover 需按时长均分时间轴（timecode 格式 HH:MM:SS.mmm），结构含开场钩子/痛点/方案/卖点/CTA。`;
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
  };
}

// ───────────────────────── 2) LLM：分镜生成 ─────────────────────────
export async function generateStoryboard(brief, script) {
  if (getProviderMode() !== "real") return demoStoryboard(brief, script);
  const model = process.env.PROMO_LLM_MODEL || "deepseek-v4-flash";
  const sys = "你是资深分镜师，把脚本拆为若干 Scene，严格只输出 JSON 数组，结构：[{index, visualPrompt, subtitle, camera, durationSec, musicClimax}]。";
  const vo = (script?.voiceover || []).map((v) => `${v.timecode} ${v.text}`).join("\n");
  const user =
    `品牌：${brief.brandName} 产品：${brief.productName}\n调性：${(brief.tones || []).join("、")}\n` +
    `时长：${brief.durationSec}s\n旁白：\n${vo}\n${langInstruction(brief.language)}\n` +
    `约每 5s 一个镜头；camera ∈ push/pull/pan/fixed；视觉风格全程统一。`;
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
  const model = process.env.PROMO_IMAGE_MODEL || "doubao-seedream-4-0-250828";
  const prompt = scene.visualPrompt;
  const body = { model, prompt, n: 1, size: process.env.PROMO_IMAGE_SIZE || "1024x576" };
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
  const [c1, c2] = paletteFor(brief.tones);
  const svg = buildPosterSVG(scene, brief, c1, c2);
  return { mediaUrl: encodeSVG(svg), kind: "image", model: "demo-seedream" };
}

// ───────────────────────── 4) TTS 配音 ─────────────────────────
export async function generateVoiceover(script, brief) {
  if (getProviderMode() !== "real") return demoVoiceover(script, brief);
  const model = process.env.PROMO_TTS_MODEL || "tiny-iceberg";
  const text = (script?.voiceover || []).map((v) => v.text).join("\n");
  const audio = await oneApiPost(
    "/audio/speech",
    { model, input: text, voice: mapVoiceTone(brief.voiceTone), response_format: "mp3" },
    { isBinary: true }
  );
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

// 服务端 FFmpeg 组装：将场景图 + 配音 + 配乐合为 MP4。要求 ffmpeg 可用且素材可本地读取。
async function ffmpegAssemble(ffmpeg, scenes, voice, music, brief) {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const { execFileSync } = await import("node:child_process");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "promo-"));
  const list = path.join(tmp, "list.txt");
  const lines = [];
  for (let i = 0; i < scenes.length; i++) {
    const s = scenes[i];
    const img = path.join(tmp, `s${i}.png`);
    if (s.mediaUrl?.startsWith("data:image")) {
      const b64 = s.mediaUrl.split(",")[1];
      fs.writeFileSync(img, Buffer.from(b64, "base64"));
    } else if (s.mediaUrl?.startsWith("http")) {
      // 远程图需可访问；此处用 curl 拉取（生产建议预下载到对象存储）。
      execFileSync("curl", ["-sL", s.mediaUrl, "-o", img]);
    } else {
      continue;
    }
    const dur = (s.durationSec || 5).toFixed(2);
    lines.push(`file '${img.replace(/'/g, "'\\''")}'\nDuration:00:00:${dur}`);
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
  args.push("-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-y", out);
  execFileSync(ffmpeg, args, { stdio: "pipe" });
  // 返回本地文件路径（生产应上传对象存储并返回直链）
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
