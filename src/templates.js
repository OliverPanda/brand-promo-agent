// 品牌模板存储（对应 PRD FR-1.3 / M4 模板库）。
// 市场运营保存一套品牌预设（Logo 主色、禁用词、默认调性、默认语言），下次一键套用，保证调性统一。
//
// 设计要点（与 store.js 同构）：
//  - 内存 Map 为读缓存；每次写操作同步写穿到磁盘 JSON（原子 temp→rename）。
//  - PROMO_PERSIST=0 时关闭读盘与写穿（测试用，内存态）——但预置模板仍须注入（见 hydrate）。
//  - 预置模板（isPreset=true / id 前缀 "preset-"）不可删除。
//
// 安全约束（M4 评审 F2/F3 修复）：
//  - isPreset 是系统标志位，绝不由调用方设置：新建恒 false，更新沿用原值。
//  - 预设判定用「标志位 + id 前缀」双保险，避免标志位被污染后保护失效。
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { parseTemplate } from "./schemas.js";

const DATA_DIR = process.env.PROMO_DATA_DIR || path.resolve(process.cwd(), "data");
const TPL_FILE = path.join(DATA_DIR, "templates.json");
const SEED_FILE = path.join(DATA_DIR, "templates.seed"); // 内容 = 当前 PRESET_SEED；用于识别旧版预置

function persistEnabled() {
  return process.env.PROMO_PERSIST !== "0";
}

/** @type {Map<string, any>} id -> BrandTemplate */
const templates = new Map();

// 预置品牌模板（FR-1.3）——按铭星链（MingStar）实际产品线定制，文案灵感与 src/copyideas.js 的 key 一一对应：
//   主品牌 / 小程序 / Studio 分镜 / 音乐配乐 / 出海英文。
// 每条模板携带 brandName/productName/coreSellingPoint，前端「套用」即可得到项目化 brief；
// 想换一批卖点与核心信息点，前端「换一批」轮换 /api/copyideas（仍围绕本产品线特点）。
// ≤5 个预置；首次启动写入；用户可在前端另存自定义模板。
// PRESET_SEED：预置内容升级标记。磁盘旧 seed 的预置（isPreset）会被本版覆盖，用户自定义模板不受影响。
const PRESET_SEED = "mingstar-v2-2026-09";
const PRESETS = [
  {
    id: "preset-mingstar", name: "铭星链 · 平台主品牌", defaultTone: "科技感", defaultLanguage: "zh-CN",
    logoColor: "#6366f1", bannedWords: ["最", "第一", "绝对"], industry: "AIGC 创作平台",
    brandName: "铭星链", productName: "铭星链创作平台",
    coreSellingPoint: "从灵感到成片，铭星链让每个人都做得起专业宣传片",
    isPreset: true,
  },
  {
    id: "preset-miniapp", name: "铭星链小程序 · 拉新", defaultTone: "专业", defaultLanguage: "zh-CN",
    logoColor: "#0ea5e9", bannedWords: ["最", "第一"], industry: "移动端创作社区",
    brandName: "铭星链", productName: "铭星链小程序",
    coreSellingPoint: "手机上的一站式 AI 创作台，通勤路上也能出片",
    isPreset: true,
  },
  {
    id: "preset-studio", name: "铭星链 Studio · 分镜大片", defaultTone: "高端", defaultLanguage: "zh-CN",
    logoColor: "#111827", bannedWords: ["便宜", "特价"], industry: "专业视频创作",
    brandName: "铭星链", productName: "铭星链 Studio",
    coreSellingPoint: "像导演一样创作：铭星链 Studio 把想法拆成可执行的分镜",
    isPreset: true,
  },
  {
    id: "preset-music", name: "铭星链音乐 · 配乐创作", defaultTone: "专业", defaultLanguage: "zh-CN",
    logoColor: "#7c3aed", bannedWords: [], industry: "AI 音乐创作",
    brandName: "铭星链", productName: "铭星链音乐",
    coreSellingPoint: "词曲唱、编曲配乐一站式生成，你的下一首歌交给铭星链",
    isPreset: true,
  },
  {
    id: "preset-global-en", name: "铭星链出海版（EN）", defaultTone: "专业", defaultLanguage: "en",
    logoColor: "#1d4ed8", bannedWords: ["#1", "best", "cheapest"], industry: "跨境/出海",
    brandName: "MingStar", productName: "MingStar Creator",
    coreSellingPoint: "From idea to promo video in one sentence — MingStar",
    isPreset: true,
  },
];

/** 预设模板判定：标志位 + id 前缀双保险（评审 F2/F3）。 */
export function isPresetTemplate(t) {
  return !!(t && (t.isPreset === true || String(t.id || "").startsWith("preset-")));
}

function hydrate() {
  // FR-1.3：预置是产品行为，与持久化开关无关 —— 先无条件注入内存。
  // 否则 PROMO_PERSIST=0 时 listTemplates() 返回空数组，模板库形同不存在（评审 F4）。
  for (const p of PRESETS) templates.set(p.id, { ...p });

  if (!persistEnabled()) return;
  try {
    if (fs.existsSync(TPL_FILE)) {
      const arr = JSON.parse(fs.readFileSync(TPL_FILE, "utf8"));
      const disk = Array.isArray(arr) ? arr : [];
      const seedMatch = fs.existsSync(SEED_FILE) && fs.readFileSync(SEED_FILE, "utf8").trim() === PRESET_SEED;
      // 磁盘预置与当前代码 seed 不一致（升级/首次加 seed）→ 丢弃磁盘上的旧版预置，保留用户自定义模板；
      // seed 一致 → 磁盘数据整体覆盖内存（含用户对预设的合法 PUT 改动）。
      const items = seedMatch
        ? disk
        : disk.filter((t) => !(t && isPresetTemplate(t)));
      for (const t of items) if (t && t.id) templates.set(t.id, t);
      persist();
      fs.writeFileSync(SEED_FILE, PRESET_SEED, "utf8");
    } else {
      persist();
      fs.writeFileSync(SEED_FILE, PRESET_SEED, "utf8");
    }
  } catch (e) {
    console.warn(`[templates] hydrate 失败，忽略磁盘数据：`, e?.message || e);
  }
}

function persist() {
  if (!persistEnabled()) return;
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = path.join(DATA_DIR, `.tpl.${process.pid}.tmp`);
    fs.writeFileSync(tmp, JSON.stringify([...templates.values()], null, 2));
    fs.renameSync(tmp, TPL_FILE); // 原子替换
  } catch (e) {
    console.warn(`[templates] 持久化失败：`, e?.message || e);
  }
}

hydrate();

export function listTemplates() {
  return [...templates.values()];
}

export function getTemplate(id) {
  return templates.get(id) || null;
}

// 创建或更新（按 id 存在判定）。校验经 BrandTemplateSchema。
// 注意：isPreset 为系统标志位，新建恒 false、更新沿用原值，调用方无法篡改（评审 F2/F3）。
export function saveTemplate(input) {
  const data = parseTemplate(input || {});
  const id = data.id || randomUUID();
  const prev = templates.get(id);
  const isPreset = prev ? prev.isPreset === true : false;
  const tpl = { ...data, id, isPreset };
  templates.set(id, tpl);
  persist();
  return tpl;
}

// 预设模板不可删除（返回 false 表示未删除）。自定义模板正常删除。
export function deleteTemplate(id) {
  const t = templates.get(id);
  if (!t) return false;
  if (isPresetTemplate(t)) return false;
  templates.delete(id);
  persist();
  return true;
}
