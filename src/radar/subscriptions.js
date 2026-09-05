// 舆情雷达 · 订阅词组（PRD 舆情雷达 v0.2 / FR-1.2）。
// 订阅 = 关键词组 × 平台集合，采集轮按订阅拉取。与 templates.js 同构：内存 Map + 原子写穿（temp→rename）。
// 预置订阅（isPreset / id 前缀 "preset-"）不可删除；PROMO_PERSIST=0 时预置仍注入（内存态）。
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const DATA_DIR = process.env.PROMO_DATA_DIR || path.resolve(process.cwd(), "data");
const SUB_FILE = path.join(DATA_DIR, "radar-subscriptions.json");

function persistEnabled() {
  return process.env.PROMO_PERSIST !== "0";
}

/** @type {Map<string, any>} id -> subscription */
const subs = new Map();

// 预置订阅：主理人未给竞品清单（PRD 决议 4），只放品牌词 + 行业词，平台为探针实测可用集合。
const PRESETS = [
  {
    id: "preset-mingstar-radar", name: "铭星链 · 默认订阅", isPreset: true,
    keywords: ["铭星链", "MingStar", "人工智能", "AI 创作", "AI 宣传片"],
    platforms: ["douyin", "xhs", "bilibili"], // weibo 路由 TikHub 未上线（2026-09-04 探针 404），暂不入默认
  },
];

// 支持的平台（与 tikhub.js 适配器对齐）
export const RADAR_PLATFORMS = ["douyin", "xhs", "bilibili", "weibo"];

function validSubscription(s) {
  const name = String(s?.name || "").trim();
  const keywords = Array.isArray(s?.keywords) ? s.keywords.map((k) => String(k).trim()).filter(Boolean) : [];
  const platforms = Array.isArray(s?.platforms) ? s.platforms.map((p) => String(p).trim()).filter(Boolean) : [];
  if (!name || name.length > 40) throw new Error("name: Required（1~40 字符）");
  if (!keywords.length || keywords.length > 20) throw new Error("keywords: 至少 1 个、至多 20 个关键词");
  if (keywords.some((k) => k.length > 40)) throw new Error("keywords: 单个关键词 ≤ 40 字符");
  if (!platforms.length || platforms.some((p) => !RADAR_PLATFORMS.includes(p))) {
    throw new Error(`platforms: 仅支持 ${RADAR_PLATFORMS.join("/")}`);
  }
  return { name, keywords, platforms };
}

function hydrate() {
  for (const p of PRESETS) subs.set(p.id, { ...p });
  if (!persistEnabled()) return;
  try {
    if (fs.existsSync(SUB_FILE)) {
      const arr = JSON.parse(fs.readFileSync(SUB_FILE, "utf8"));
      for (const s of Array.isArray(arr) ? arr : []) {
        if (s && s.id && !String(s.id).startsWith("preset-")) subs.set(s.id, s); // 磁盘预置不作数，以代码内为准
      }
    }
    persist();
  } catch (e) {
    console.warn("[radar-subscriptions] hydrate 失败，忽略磁盘数据：", e?.message || e);
  }
}

function persist() {
  if (!persistEnabled()) return;
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = path.join(DATA_DIR, `.radar-sub.${process.pid}.tmp`);
    fs.writeFileSync(tmp, JSON.stringify([...subs.values()], null, 2));
    fs.renameSync(tmp, SUB_FILE);
  } catch (e) {
    console.warn("[radar-subscriptions] 持久化失败：", e?.message || e);
  }
}

hydrate();

export function listSubscriptionGroups() {
  return [...subs.values()];
}

export function saveSubscriptionGroup(input) {
  const data = validSubscription(input);
  const id = String(input?.id || "").trim() && !String(input.id).startsWith("preset-") ? String(input.id) : randomUUID();
  const prev = subs.get(id);
  const s = { ...data, id, isPreset: prev?.isPreset === true, createdAt: prev?.createdAt || new Date().toISOString() };
  subs.set(id, s);
  persist();
  return s;
}

export function deleteSubscriptionGroup(id) {
  const s = subs.get(id);
  if (!s) return false;
  if (s.isPreset === true || String(id).startsWith("preset-")) return false;
  subs.delete(id);
  persist();
  return true;
}

// 全部关键词去重（采集轮遍历用）
export function allKeywords() {
  const set = new Set();
  for (const s of subs.values()) for (const k of s.keywords) set.add(k);
  return [...set];
}
