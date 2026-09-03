// 运行时配置（免重启生效的服务端覆盖项）。
// 当前仅一项：providerBaseUrl —— one-api 兼容网关地址，覆盖 env 的 PROMO_ONEAPI_BASE_URL。
//   - 持久化：data/runtime-config.json（写穿 + 原子替换），PROMO_PERSIST=0 时仅内存态（测试）。
//   - 安全：只存 URL 不存密钥；密钥仍走 env（PROMO_ONEAPI_API_KEY），绝不下发前端。
//   - 读取时机：providers 每次真实调用时取「当前生效值」，改完立即生效、无需重启。
import fs from "node:fs";
import path from "node:path";

const DATA_DIR = process.env.PROMO_DATA_DIR || path.resolve(process.cwd(), "data");
const CFG_FILE = path.join(DATA_DIR, "runtime-config.json");

function persistEnabled() {
  return process.env.PROMO_PERSIST !== "0";
}

/** @type {{ providerBaseUrl?: string }} */
const state = {};

function load() {
  if (!persistEnabled()) return;
  try {
    if (fs.existsSync(CFG_FILE)) {
      const j = JSON.parse(fs.readFileSync(CFG_FILE, "utf8"));
      if (typeof j.providerBaseUrl === "string") state.providerBaseUrl = j.providerBaseUrl.trim();
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
  return getRuntimeConfig();
}

// 当前生效的 one-api 网关地址：运行时配置覆盖 > env（PROMO_ONEAPI_BASE_URL / MINGSTAR_LLM_BASE_URL）。
export function getEffectiveOneApiBase() {
  return state.providerBaseUrl || process.env.PROMO_ONEAPI_BASE_URL || process.env.MINGSTAR_LLM_BASE_URL || "";
}

// 供应商地址合法性：仅接受 http(s) URL；空串允许（= 清除覆盖回退 env）。
export function validateProviderBaseUrl(v) {
  const s = String(v || "").trim();
  if (!s) return { ok: true, value: "" };
  if (s.length > 200) return { ok: false, error: "地址过长（≤200 字符）" };
  if (!/^https?:\/\/\S+$/i.test(s)) return { ok: false, error: "供应商地址须为 http(s)://… 完整 URL" };
  return { ok: true, value: s };
}
