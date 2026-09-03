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

function persistEnabled() {
  return process.env.PROMO_PERSIST !== "0";
}

/** @type {Map<string, any>} id -> BrandTemplate */
const templates = new Map();

// ≤5 个预置品牌模板（FR-1.3）。首次启动写入；用户可在前端另存自定义模板。
const PRESETS = [
  {
    id: "preset-tech", name: "科技品牌标准", defaultTone: "科技感", defaultLanguage: "zh-CN",
    logoColor: "#0ea5e9", bannedWords: ["最", "第一", "绝对"], industry: "科技/数码", isPreset: true,
  },
  {
    id: "preset-guochao", name: "国潮品牌标准", defaultTone: "国潮", defaultLanguage: "zh-CN",
    logoColor: "#dc2626", bannedWords: ["最", "第一"], industry: "文创/服饰", isPreset: true,
  },
  {
    id: "preset-warm", name: "温情品牌标准", defaultTone: "温情", defaultLanguage: "zh-CN",
    logoColor: "#f59e0b", bannedWords: [], industry: "母婴/生活", isPreset: true,
  },
  {
    id: "preset-luxury", name: "高端品牌标准", defaultTone: "高端", defaultLanguage: "zh-CN",
    logoColor: "#111827", bannedWords: ["便宜", "特价"], industry: "奢侈品/腕表", isPreset: true,
  },
  {
    id: "preset-global-en", name: "海外英文品牌", defaultTone: "专业", defaultLanguage: "en",
    logoColor: "#1d4ed8", bannedWords: ["#1", "best", "cheapest"], industry: "跨境/出海", isPreset: true,
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
      // 磁盘数据覆盖内存（含用户对预设的合法改动）；异常条目跳过，不覆盖预置。
      if (Array.isArray(arr)) for (const t of arr) if (t && t.id) templates.set(t.id, t);
    } else {
      persist();
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
