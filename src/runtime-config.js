// 运行时配置（免重启生效的服务端覆盖项）。
// 三项：providerBaseUrl（one-api 网关地址）/ providerMode（demo|real）/ apiKey（网关密钥）。
//   - 覆盖语义：运行时配置 > env（PROMO_ONEAPI_BASE_URL / PROMO_PROVIDER_MODE / PROMO_ONEAPI_API_KEY）。
//   - 持久化：data/runtime-config.json（写穿 + 原子替换），PROMO_PERSIST=0 时仅内存态（测试）。
//   - 安全：apiKey 为「可写不可读」——浏览器→服务端单向写入一次落本地盘（data/ 已 gitignore），
//     GET /api/config 只回 apiKeySet 布尔，密钥绝不回显、绝不下发前端。
//   - 读取时机：providers 每次真实调用时取「当前生效值」，改完立即生效、无需重启。
import fs from "node:fs";
import path from "node:path";

const DATA_DIR = process.env.PROMO_DATA_DIR || path.resolve(process.cwd(), "data");
const CFG_FILE = path.join(DATA_DIR, "runtime-config.json");

function persistEnabled() {
  return process.env.PROMO_PERSIST !== "0";
}

/** @type {{ providerBaseUrl?: string, providerMode?: string, apiKey?: string }} */
const state = {};

function load() {
  if (!persistEnabled()) return;
  try {
    if (fs.existsSync(CFG_FILE)) {
      const j = JSON.parse(fs.readFileSync(CFG_FILE, "utf8"));
      if (typeof j.providerBaseUrl === "string") state.providerBaseUrl = j.providerBaseUrl.trim();
      if (j.providerMode === "real" || j.providerMode === "demo") state.providerMode = j.providerMode;
      if (typeof j.apiKey === "string" && j.apiKey) state.apiKey = j.apiKey;
    }
  } catch (e) {
    console.warn(`[runtime-config] 读取失败，忽略：`, e?.message || e);
  }
}

function persist() {
  if (!persistEnabled()) return;
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = path.join(DATA_DIR, `.cfg.${process.pid}.tmp`);
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
    fs.renameSync(tmp, CFG_FILE);
  } catch (e) {
    console.warn(`[runtime-config] 持久化失败：`, e?.message || e);
  }
}

load();

export function getRuntimeConfig() {
  return { ...state };
}

// patch 仅接受白名单键；空串视为清除覆盖（回落到 env 默认）。
export function setRuntimeConfig(patch = {}) {
  if (patch.providerBaseUrl !== undefined) {
    state.providerBaseUrl = String(patch.providerBaseUrl).trim();
    persist();
  }
  if (patch.providerMode !== undefined) {
    const m = String(patch.providerMode).trim();
    state.providerMode = m === "real" || m === "demo" ? m : "";
    persist();
  }
  if (patch.apiKey !== undefined) {
    const k = String(patch.apiKey).trim();
    state.apiKey = k || undefined; // 空 = 清除已存密钥
    persist();
  }
  return getRuntimeConfig();
}

// 当前生效的 one-api 网关地址：运行时配置覆盖 > env（PROMO_ONEAPI_BASE_URL / MINGSTAR_LLM_BASE_URL）。
export function getEffectiveOneApiBase() {
  return state.providerBaseUrl || process.env.PROMO_ONEAPI_BASE_URL || process.env.MINGSTAR_LLM_BASE_URL || "";
}

/**
 * 返回当前生效的运行模式：运行时覆盖 > 显式环境变量 > 默认 real。
 *
 * @returns {"demo" | "real"} 生效模式。
 * @example
 * getEffectiveProviderMode();
 */
export function getEffectiveProviderMode() {
  if (state.providerMode === "real" || state.providerMode === "demo") return state.providerMode;
  if (process.env.PROMO_PROVIDER_MODE === "real" || process.env.PROMO_PROVIDER_MODE === "demo") {
    return process.env.PROMO_PROVIDER_MODE;
  }
  return "real";
}

// 当前生效的网关密钥：运行时配置（页面保存）> env（PROMO_ONEAPI_API_KEY / OPENAI_API_KEY）。
export function getEffectiveOneApiKey() {
  return state.apiKey || process.env.PROMO_ONEAPI_API_KEY || process.env.OPENAI_API_KEY || "";
}

// 供应商地址合法性：仅接受 http(s) URL；空串允许（= 清除覆盖回退 env）。
export function validateProviderBaseUrl(v) {
  const s = String(v || "").trim();
  if (!s) return { ok: true, value: "" };
  if (s.length > 200) return { ok: false, error: "地址过长（≤200 字符）" };
  if (!/^https?:\/\/\S+$/i.test(s)) return { ok: false, error: "供应商地址须为 http(s)://… 完整 URL" };
  return { ok: true, value: s };
}

// 运行模式合法性：仅 demo | real；空串允许（= 清除覆盖，回退 env）。
export function validateProviderMode(v) {
  const s = String(v || "").trim();
  if (!s) return { ok: true, value: "" };
  if (s !== "demo" && s !== "real") return { ok: false, error: "运行模式仅支持 demo（离线演示）或 real（真实调用）" };
  return { ok: true, value: s };
}

// API Key 合法性：任意非空 ≤200 字符；空串允许（= 清除已存密钥）。
export function validateApiKey(v) {
  const s = String(v || "").trim();
  if (!s) return { ok: true, value: "" };
  if (s.length > 200) return { ok: false, error: "API Key 过长（≤200 字符）" };
  return { ok: true, value: s };
}
