// 舆情雷达 · Mention 存储（PRD FR-1.5 幂等去重 / FR-1.6 脱敏）。
// id = 平台 + 内容指纹（sha1(platform + url || platform + text) 前 16 位）——同内容重复采集天然幂等。
// 内存 Map + 原子写穿（与 store/templates 同构）；容量上限 PROMO_RADAR_MENTION_CAP（默认 5000，超出按采集时间淘汰最旧）。
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const DATA_DIR = process.env.PROMO_DATA_DIR || path.resolve(process.cwd(), "data");
const FILE = path.join(DATA_DIR, "radar-mentions.json");
const CAP = Number(process.env.PROMO_RADAR_MENTION_CAP ?? 5000);

function persistEnabled() {
  return process.env.PROMO_PERSIST !== "0";
}

// 内容指纹哈希（sha1 前 16 位）——tikhub.js 的 authorHash/demo id 复用同一实现
export function hashId(str) {
  return createHash("sha1").update(str).digest("hex").slice(0, 16);
}

/** @type {Map<string, any>} id -> mention */
const mentions = new Map();

function hydrate() {
  if (!persistEnabled()) return;
  try {
    if (!fs.existsSync(FILE)) return;
    const arr = JSON.parse(fs.readFileSync(FILE, "utf8"));
    for (const m of Array.isArray(arr) ? arr : []) if (m && m.id) mentions.set(m.id, m);
  } catch (e) {
    console.warn("[radar-mentions] hydrate 失败，忽略磁盘数据：", e?.message || e);
  }
}

function persist() {
  if (!persistEnabled()) return;
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = path.join(DATA_DIR, `.radar-mentions.${process.pid}.tmp`);
    fs.writeFileSync(tmp, JSON.stringify([...mentions.values()], null, 2));
    fs.renameSync(tmp, FILE);
  } catch (e) {
    console.warn("[radar-mentions] 持久化失败：", e?.message || e);
  }
}

hydrate();

export function mentionId(platform, m) {
  const basis = m.url || m.text || "";
  return `${platform}-${hashId(platform + basis)}`;
}

/**
 * 批量加入（去重）。返回 { added, duplicates, items }。
 * items 为本轮新增的 mention（已带 id / crawledAt）。
 */
export function addMentions(list) {
  let added = 0;
  let duplicates = 0;
  const items = [];
  for (const m of list || []) {
    const id = m.id || mentionId(m.platform, m);
    if (mentions.has(id)) {
      duplicates++;
      continue;
    }
    const record = {
      ...m,
      id,
      crawledAt: new Date().toISOString(),
      metrics: { likes: 0, comments: 0, shares: 0, ...(m.metrics || {}) },
    };
    delete record.author; // 隐私兜底（FR-1.6）：只允许脱敏 authorHash 入库，原始作者名一律丢弃
    mentions.set(id, record);
    items.push(record);
    added++;
  }
  trimToCap();
  persist();
  return { added, duplicates, items };
}

// 容量裁剪：按 crawledAt 淘汰最旧（只在超限时触发，摊销 O(n log n)）
function trimToCap() {
  if (mentions.size <= CAP) return;
  const sorted = [...mentions.values()].sort((a, b) => String(a.crawledAt).localeCompare(String(b.crawledAt)));
  const remove = sorted.slice(0, mentions.size - CAP);
  for (const m of remove) mentions.delete(m.id);
}

export function listMentions({ limit = 100, platform, keyword, windowHours } = {}) {
  let arr = [...mentions.values()];
  if (platform) arr = arr.filter((m) => m.platform === platform);
  if (keyword) arr = arr.filter((m) => (m.text || "").includes(keyword) || (m.keywordSet || "").includes(keyword));
  if (windowHours) {
    const since = Date.now() - windowHours * 3600 * 1000;
    arr = arr.filter((m) => new Date(m.crawledAt).getTime() >= since);
  }
  arr.sort((a, b) => String(b.crawledAt).localeCompare(String(a.crawledAt)));
  return arr.slice(0, limit);
}

export function allMentions() {
  return [...mentions.values()];
}

export function mentionCount() {
  return mentions.size;
}

// 仅测试用：清空内存态（PROMO_PERSIST=0 时本就不落盘）
export function _resetMentions() {
  mentions.clear();
}
