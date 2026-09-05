// 舆情雷达 · LLM 情绪打分（M2 收窄版：只打分，不做告警 / 不做站内信 —— 2026-09-04 主理人决定）。
// 输出口径：每条 mention → { sentiment: pos|neu|neg, score: -1~+1, confidence: 0~1, source: llm|dict|demo }
//   严格负面口径：sentiment === "neg" && confidence >= 0.6（词典降级 confidence=0.55，故意不进严格口径，
//   避免词典误判污染「负面声量」指标；DEMO confidence=0.9 可进）。
// 降本三板斧（PRD FR-4.2）：
//   ① 指纹缓存：mentionId（内容指纹）→ 打分结果写穿 data/radar-sentiment.json，重复内容零重复计费；
//   ② 批量 ≤ PROMO_NLP_BATCH_SIZE（默认 20）：一次 chat/completions 打包多条，压请求次数；
//   ③ 每日预算 PROMO_NLP_DAILY_CAP：当日 LLM 已打分条数达到上限 → 后续自动降级词典规则（不报错，精度下降）。
// 模式分支：
//   DEMO（getEffectiveProviderMode()!=="real"）→ 基于特征词的确定性打分（零外部依赖、可复现，confidence 0.9）；
//   real + 网关已配置 → one-api LLM 批量打分（反讽/阴阳怪气判负面的指令写在 system）；
//   real + 网关未配置 / LLM 单批失败 / 超每日预算 → 词典规则降级（source=dict）。
import fs from "node:fs";
import path from "node:path";
import { getEffectiveOneApiBase, getEffectiveOneApiKey, getEffectiveProviderMode } from "../runtime-config.js";
import { oneApiPost, parseJSONSafe } from "../mastra/providers.js";

const DATA_DIR = process.env.PROMO_DATA_DIR || path.resolve(process.cwd(), "data");
const FILE = path.join(DATA_DIR, "radar-sentiment.json");
const BATCH_SIZE = Math.max(1, Number(process.env.PROMO_NLP_BATCH_SIZE ?? 20));
const DAILY_CAP = Math.max(0, Number(process.env.PROMO_NLP_DAILY_CAP ?? 0)); // 0 = 不限

function persistEnabled() {
  return process.env.PROMO_PERSIST !== "0";
}

/** @type {Map<string, {sentiment:string, score:number, confidence:number, source:string, scoredAt:string}>} */
const scores = new Map();

function hydrate() {
  if (!persistEnabled()) return;
  try {
    if (!fs.existsSync(FILE)) return;
    const obj = JSON.parse(fs.readFileSync(FILE, "utf8"));
    for (const [k, v] of Object.entries(obj || {})) {
      if (v && typeof v.sentiment === "string") scores.set(k, v);
    }
  } catch (e) {
    console.warn("[radar-sentiment] hydrate 失败，忽略磁盘数据：", e?.message || e);
  }
}

function persist() {
  if (!persistEnabled()) return;
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = path.join(DATA_DIR, `.radar-sentiment.${process.pid}.tmp`);
    fs.writeFileSync(tmp, JSON.stringify(Object.fromEntries(scores), null, 2));
    fs.renameSync(tmp, FILE);
  } catch (e) {
    console.warn("[radar-sentiment] 持久化失败：", e?.message || e);
  }
}

hydrate();

export function getScore(id) {
  return scores.get(id) || null;
}

export function sentimentCount() {
  return scores.size;
}

// 当日 LLM 已打分条数（预算控制口径；dict/demo 不计入）
export function nlpUsageToday() {
  const today = new Date().toISOString().slice(0, 10);
  let n = 0;
  for (const s of scores.values()) {
    if (s.source === "llm" && String(s.scoredAt || "").slice(0, 10) === today) n++;
  }
  return n;
}

export function nlpConfig() {
  return {
    mode: getEffectiveProviderMode(),
    gatewayReady: !!(getEffectiveOneApiBase() && getEffectiveOneApiKey()),
    model: process.env.PROMO_RADAR_NLP_MODEL || process.env.PROMO_LLM_MODEL || "deepseek-v4-flash",
    batchSize: BATCH_SIZE,
    dailyCap: DAILY_CAP,
    usedToday: nlpUsageToday(),
    scored: scores.size,
  };
}

// 仅测试用：清空内存态（PROMO_PERSIST=0 时本就不落盘）
export function _resetSentiment() {
  scores.clear();
}

// ── 词典规则降级（source=dict，confidence 0.55 —— 故意低于 0.6 严格负面门槛） ──
const NEG_WORDS = ["翻车", "避雷", "踩坑", "失望", "差评", "垃圾", "维权", "投诉", "后悔", "难用", "智商税", "割韭菜", "骗局", "劝退", "翻大车", "翻车了", "离谱", "无语", "拉黑", "退款"];
const POS_WORDS = ["好用", "推荐", "提升", "喜欢", "真香", "不错", "惊艳", "值得", "宝藏", "神器", "满意", "顺畅", "良心", "高效", "惊喜", "赞"];

export function dictScore(text) {
  const s = String(text || "");
  let neg = 0;
  let pos = 0;
  for (const w of NEG_WORDS) if (s.includes(w)) neg++;
  for (const w of POS_WORDS) if (s.includes(w)) pos++;
  if (neg > pos) return { sentiment: "neg", score: Math.max(-1, -0.4 - 0.15 * neg), confidence: 0.55, source: "dict" };
  if (pos > neg) return { sentiment: "pos", score: Math.min(1, 0.4 + 0.15 * pos), confidence: 0.55, source: "dict" };
  return { sentiment: "neu", score: 0, confidence: 0.5, source: "dict" };
}

// ── DEMO 确定性打分见下方 demoScore（复用词典词表，confidence 0.9） ──

function normalize(r, fallback) {
  const sentiment = ["pos", "neu", "neg"].includes(r?.sentiment) ? r.sentiment : fallback.sentiment;
  const score = Number.isFinite(r?.score) ? Math.min(1, Math.max(-1, r.score)) : fallback.score;
  const confidence = Number.isFinite(r?.confidence) ? Math.min(1, Math.max(0, r.confidence)) : fallback.confidence;
  return { sentiment, score, confidence, source: fallback.source };
}

// ── DEMO 确定性打分（source=demo，confidence 0.9；复用词典词表保证特征覆盖一致，零外部依赖、可复现） ──
export function demoScore(text) {
  return { ...dictScore(text), confidence: 0.9, source: "demo" };
}

// ── one-api LLM 批量打分（复用 providers 的 oneApiPost：同 base/key/超时/错误处理） ──
async function llmBatch(items) {
  const model = process.env.PROMO_RADAR_NLP_MODEL || process.env.PROMO_LLM_MODEL || "deepseek-v4-flash";
  const payload = items.map((m, i) => ({ i, text: String(m.text || "").slice(0, 300) }));
  const sys =
    "你是舆情情绪分析器。对每条社媒内容判断情绪倾向，严格只输出 JSON（不含解释），" +
    '结构：{"results":[{"i":序号,"sentiment":"pos|neu|neg","score":-1到1的小数,"confidence":0到1}]}。' +
    "注意：反讽、阴阳怪气、明褒实贬一律判负面（neg）；纯客观陈述/提问判中性（neu）。";
  const data = await oneApiPost("/chat/completions", {
    model,
    messages: [
      { role: "system", content: sys },
      { role: "user", content: JSON.stringify(payload) },
    ],
    response_format: { type: "json_object" },
    temperature: 0.1,
  }, { timeoutMs: Number(process.env.PROMO_NLP_TIMEOUT_MS ?? 60000) });
  const parsed = parseJSONSafe(data?.choices?.[0]?.message?.content || "{}");
  const byIndex = new Map();
  for (const r of Array.isArray(parsed?.results) ? parsed.results : []) {
    if (r && Number.isInteger(r.i)) byIndex.set(r.i, r);
  }
  return { byIndex, tokens: data?.usage?.total_tokens ?? 0, model };
}

/**
 * 对未打分的 mention 批量打分（已打分的靠指纹缓存跳过，零成本）。
 * 返回 { pending, llmScored, dictScored, demoScored, cacheSkipped, downgraded, batches, errors }。
 */
export async function scorePendingMentions(allMentions, { limit } = {}) {
  const mode = getEffectiveProviderMode();
  const gatewayReady = !!(getEffectiveOneApiBase() && getEffectiveOneApiKey());
  const useLlm = mode === "real" && gatewayReady;
  const inputAll = (allMentions || []).filter((m) => m && m.id);
  const pendingAll = inputAll.filter((m) => !scores.has(m.id));
  const pending = limit ? pendingAll.slice(0, limit) : pendingAll;
  const stats = {
    pending: pending.length,
    llmScored: 0,
    dictScored: 0,
    demoScored: 0,
    cacheSkipped: inputAll.length - pending.length,
    downgraded: false,
    batches: 0,
    tokens: 0,
    errors: [],
    mode: useLlm ? "llm" : mode === "real" ? "dict" : "demo",
  };

  for (let i = 0; i < pending.length; i += BATCH_SIZE) {
    const batch = pending.slice(i, i + BATCH_SIZE);
    // ③ 每日预算：达到上限即降级（按批检查，批内不再拆分）
    if (useLlm && DAILY_CAP > 0 && nlpUsageToday() >= DAILY_CAP) {
      stats.downgraded = true;
      for (const m of batch) {
        const r = normalize(null, dictScore(m.text));
        scores.set(m.id, { ...r, scoredAt: new Date().toISOString() });
        stats.dictScored++;
      }
      continue;
    }
    if (useLlm) {
      try {
        const { byIndex, tokens, model } = await llmBatch(batch);
        stats.batches++;
        stats.tokens += tokens;
        batch.forEach((m, idx) => {
          const r = byIndex.get(idx);
          const fallback = dictScore(m.text);
          const norm = normalize(r, fallback);
          scores.set(m.id, {
            ...norm,
            source: r && ["pos", "neu", "neg"].includes(r.sentiment) ? "llm" : "dict", // LLM 单条缺失/非法 → 词典兜底
            scoredAt: new Date().toISOString(),
            model: r ? model : undefined,
          });
          if (r && ["pos", "neu", "neg"].includes(r.sentiment)) stats.llmScored++;
          else stats.dictScored++;
        });
      } catch (e) {
        stats.errors.push(String(e?.message || e).slice(0, 160));
        for (const m of batch) {
          const r = normalize(null, dictScore(m.text));
          scores.set(m.id, { ...r, scoredAt: new Date().toISOString() });
          stats.dictScored++;
        }
      }
    } else {
      // DEMO / 网关未配置：确定性打分（demo）或词典（real 但网关缺失时也走 demo 特征词更准 → 统一 demoScore）
      for (const m of batch) {
        const r = demoScore(m.text);
        scores.set(m.id, { ...r, scoredAt: new Date().toISOString() });
        stats.demoScored++;
      }
    }
  }
  if (pending.length) persist();
  return stats;
}

/**
 * 聚合摘要：把打分结果合并进 mention 列表后统计。
 * 负面声量（严格口径）= sentiment==="neg" && confidence >= 0.6。
 * 情绪指数 = (平均 score + 1) × 50 → 0(极负)~100(极正)。
 */
export function sentimentSummary(mentions, { windowHours } = {}) {
  let arr = (mentions || []).filter((m) => m && m.id);
  if (windowHours) {
    const since = Date.now() - windowHours * 3600 * 1000;
    arr = arr.filter((m) => new Date(m.crawledAt || 0).getTime() >= since);
  }
  const items = arr.map((m) => {
    const s = scores.get(m.id);
    return s ? { ...m, sentiment: s.sentiment, sentimentScore: s.score, sentimentConfidence: s.confidence, sentimentSource: s.source } : m;
  });
  const scored = items.filter((m) => m.sentiment);
  const pos = scored.filter((m) => m.sentiment === "pos").length;
  const neu = scored.filter((m) => m.sentiment === "neu").length;
  const neg = scored.filter((m) => m.sentiment === "neg").length;
  const negativeVolume = scored.filter((m) => m.sentiment === "neg" && m.sentimentConfidence >= 0.6).length;
  const avg = scored.length ? scored.reduce((a, m) => a + m.sentimentScore, 0) / scored.length : 0;
  const byPlatform = {};
  for (const m of scored) {
    const p = m.platform || "unknown";
    byPlatform[p] = byPlatform[p] || { total: 0, neg: 0 };
    byPlatform[p].total++;
    if (m.sentiment === "neg") byPlatform[p].neg++;
  }
  return {
    total: items.length,
    scored: scored.length,
    unscored: items.length - scored.length,
    pos,
    neu,
    neg,
    negativeVolume,
    negRatio: scored.length ? Math.round((negativeVolume / scored.length) * 1000) / 10 : 0,
    index: scored.length ? Math.round((avg + 1) * 50) : null,
    byPlatform,
  };
}
