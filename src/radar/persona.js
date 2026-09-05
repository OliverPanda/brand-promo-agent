// 舆情雷达 · 品牌人设库（Tone & Voice，PRD FR-6 轻量版）。
// 单例档案：data/radar-persona.json（内存 Map + 原子写穿，与 mentions/sentiment 同范式）。
// 用途：① 选题 Agent 的全局约束注入（调性/禁用词/禁忌话题）；② 选题一键下发时的 Brief 预填
//      （brandName/productName/卖点/调性/受众/主色/语言，复用 BrandBriefSchema 校验字段集）。
// FR-6.2「与模板库同源复用」本期简化为人设库作为 Brief 预填上游；双向自动同步留后续。
import fs from "node:fs";
import path from "node:path";
import { LOGO_COLOR, LANGUAGES } from "../schemas.js";

const DATA_DIR = process.env.PROMO_DATA_DIR || path.resolve(process.cwd(), "data");
const FILE = path.join(DATA_DIR, "radar-persona.json");

function persistEnabled() {
  return process.env.PROMO_PERSIST !== "0";
}

// 预设人设（铭星链）：首次读取无落盘文件时的兜底值；用户保存后覆盖。
export const PRESET_PERSONA = {
  id: "preset-mingstar-persona",
  isPreset: true,
  brandName: "铭星链",
  productName: "MingStar AIGC 创作平台",
  coreSellingPoint: "一站式 AI 内容创作，从选题到成片",
  tagline: "让每一条好内容都有迹可循",
  audience: ["内容创作者", "品牌市场团队"],
  tones: ["科技感", "专业"],
  keyMessages: ["选题有据", "生成高效", "品牌调性不跑偏"],
  bannedWords: ["最好", "第一", "绝对"],
  taboos: ["政治", "竞品贬损", "未经证实的数据承诺"],
  logoColor: "#0ea5e9",
  language: "zh-CN",
  voiceTone: "男声",
};

/** @type {Record<string, any>} */
let persona = { ...PRESET_PERSONA };

function hydrate() {
  if (!persistEnabled()) return;
  try {
    if (!fs.existsSync(FILE)) return;
    const j = JSON.parse(fs.readFileSync(FILE, "utf8"));
    if (j && typeof j === "object") persona = { ...PRESET_PERSONA, ...j, isPreset: true };
  } catch (e) {
    console.warn("[radar-persona] hydrate 失败，使用预置人设：", e?.message || e);
  }
}

function persist() {
  if (!persistEnabled()) return;
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = path.join(DATA_DIR, `.radar-persona.${process.pid}.tmp`);
    fs.writeFileSync(tmp, JSON.stringify(persona, null, 2));
    fs.renameSync(tmp, FILE);
  } catch (e) {
    console.warn("[radar-persona] 持久化失败：", e?.message || e);
  }
}

hydrate();

function strArr(v, { max = 12, maxLen = 40 } = {}) {
  if (!Array.isArray(v)) return null;
  const arr = v.map((s) => String(s).trim()).filter(Boolean).slice(0, max);
  return arr.every((s) => s.length <= maxLen) ? arr : null;
}

/**
 * 保存（合并式 patch）。字段级校验，非法即抛错（server 转 400）。
 * isPreset/id 恒保持预置值——人设是单例，不可伪造降格或改 id。
 */
export function savePersona(patch = {}) {
  const p = { ...persona };
  const S = (k, maxLen) => {
    if (patch[k] !== undefined) {
      const v = String(patch[k]).trim();
      if (!v || v.length > maxLen) throw new Error(`${k} 必填且 ≤${maxLen} 字`);
      p[k] = v;
    }
  };
  if (patch.brandName !== undefined) S("brandName", 60);
  if (patch.productName !== undefined) S("productName", 60);
  if (patch.coreSellingPoint !== undefined) S("coreSellingPoint", 60);
  if (patch.tagline !== undefined) S("tagline", 60);
  for (const k of ["audience", "tones", "keyMessages", "bannedWords", "taboos"]) {
    if (patch[k] !== undefined) {
      const arr = strArr(patch[k]);
      if (!arr) throw new Error(`${k} 须为字符串数组（≤12 项，单项 ≤40 字）`);
      p[k] = arr;
    }
  }
  if (patch.logoColor !== undefined && patch.logoColor !== "") {
    const r = LOGO_COLOR.safeParse(patch.logoColor);
    if (!r.success) throw new Error("主色须为 #RGB 或 #RRGGBB 格式");
    p.logoColor = r.data;
  }
  if (patch.language !== undefined) {
    if (!LANGUAGES.includes(patch.language)) throw new Error(`语言须为 ${LANGUAGES.join("/")}`);
    p.language = patch.language;
  }
  if (patch.voiceTone !== undefined) S("voiceTone", 20);
  persona = { ...p, id: PRESET_PERSONA.id, isPreset: true };
  persist();
  return getPersona();
}

export function getPersona() {
  return { ...persona };
}

// 禁用词 / 禁忌话题命中文本检查（选题过滤 + 生成约束共用）
export function personaViolations(text) {
  const s = String(text || "");
  const hits = [...(persona.bannedWords || []), ...(persona.taboos || [])].filter((w) => w && s.includes(w));
  return hits;
}

// 仅测试用
export function _resetPersona() {
  persona = { ...PRESET_PERSONA };
}
