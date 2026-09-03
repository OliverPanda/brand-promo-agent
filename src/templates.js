// 品牌模板存储（对应 PRD FR-1.3 / M4 模板库）。
// 市场运营保存一套品牌预设（Logo 主色、禁用词、默认调性、默认语言），下次一键套用，保证调性统一。
//
// 设计要点（与 store.js 同构）：
//  - 内存 Map 为读缓存；每次写操作同步写穿到磁盘 JSON（原子 temp→rename）。
//  - PROMO_PERSIST=0 时关闭写穿与启动 hydrate（测试用，内存态）。
//  - 首次启动（模板文件不存在）自动写入 ≤5 个预置模板（isPreset=true）。
//  - 预设模板不可删除（deleteTemplate 对预设返回 false，由 server 转 409）。
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

function hydrate() {
  if (!persistEnabled()) return;
  try {
    if (fs.existsSync(TPL_FILE)) {
      const arr = JSON.parse(fs.readFileSync(TPL_FILE, "utf8"));
      if (Array.isArray(arr)) for (const t of arr) if (t && t.id) templates.set(t.id, t);
    } else {
      // 首次：写入预置模板
      for (const p of PRESETS) templates.set(p.id, p);
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
export function saveTemplate(input) {
  const data = parseTemplate(input || {});
  const id = data.id || randomUUID();
  const tpl = { ...data, id, isPreset: data.isPreset ?? false };
  templates.set(id, tpl);
  persist();
  return tpl;
}

// 预设模板不可删除（返回 false 表示未删除）。自定义模板正常删除。
export function deleteTemplate(id) {
  const t = templates.get(id);
  if (!t) return false;
  if (t.isPreset) return false;
  templates.delete(id);
  persist();
  return true;
}

// 将模板回灌为 Brief 字段（前端亦可直接读取模板字段合并；此函数供服务端/测试复用）。
export function templateToBrief(tpl) {
  return {
    brandName: tpl.brandName || "",
    productName: tpl.productName || "",
    coreSellingPoint: tpl.coreSellingPoint || "",
    tones: [tpl.defaultTone].filter(Boolean),
    language: tpl.defaultLanguage || "zh-CN",
    logoColor: tpl.logoColor,
    bannedWords: tpl.bannedWords || [],
  };
}
