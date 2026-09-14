// 账户级累计配额（对应 PRD FR-10「成本配额」/ §13 M3）。
// 与单 run 的「预算上限 PROMO_BUDGET_CAP」不同，配额是「账户（createdBy）跨多次运行的累计花费上限」，
// 用于「可上线内测」下防止单个品牌/用户烧穿总额度。仅真实 Provider 产生成本时计量（DEMO 零成本不计）。
//
// 持久化：<PROMO_DATA_DIR>/quotas.json（与 runs.json 同目录）；PROMO_PERSIST=0 时仅内存（测试用）。
// 上限 PROMO_QUOTA_CAP（元/账户，默认 ¥200），运行时实时读取，便于不改代码调整。
import fs from "node:fs";
import path from "node:path";

const DATA_DIR = process.env.PROMO_DATA_DIR || path.resolve(process.cwd(), "data");
const QUOTA_FILE = path.join(DATA_DIR, "quotas.json");

function persistEnabled() {
  return process.env.PROMO_PERSIST !== "0";
}

/** @type {Record<string, number>} account -> 已用累计（元） */
let quotas = {};

function readCap() {
  return Number(process.env.PROMO_QUOTA_CAP ?? 200);
}

function hydrate() {
  if (!persistEnabled()) return;
  try {
    if (fs.existsSync(QUOTA_FILE)) {
      const obj = JSON.parse(fs.readFileSync(QUOTA_FILE, "utf8"));
      if (obj && typeof obj === "object") quotas = obj;
    }
  } catch (e) {
    console.warn(`[quota] hydrate 失败，忽略磁盘数据：`, e?.message || e);
  }
}

function persist() {
  if (!persistEnabled()) return;
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(QUOTA_FILE, JSON.stringify(quotas));
  } catch (e) {
    console.warn(`[quota] 持久化失败：`, e?.message || e);
  }
}

hydrate();

export function getQuotaCap() {
  return readCap();
}

export function getUsage(account = "anonymous") {
  return quotas[account] || 0;
}

// 预测加入 amount 后是否仍在配额内。返回 { ok, used, cap, remaining, total }。
export function checkQuota(account = "anonymous", amount = 0) {
  const cap = readCap();
  const used = quotas[account] || 0;
  const total = used + amount;
  return {
    ok: total <= cap,
    used: round4(used),
    cap,
    remaining: round4(Math.max(0, cap - total)),
    total: round4(total),
  };
}

export function addUsage(account, amount) {
  if (!account) return;
  quotas[account] = round4((quotas[account] || 0) + (amount || 0));
  persist();
}

function round4(n) {
  return Math.round((n + Number.EPSILON) * 10000) / 10000;
}

// 配额超限错误：recordCost 抛出，由 server 阶段边界确认 run=failed（对应 FR-10 中止并提示）。
export class QuotaExceededError extends Error {
  constructor(message) {
    super(message);
    this.name = "QuotaExceededError";
    this.code = "QUOTA_EXCEEDED";
    this.retryable = false;
  }
}
