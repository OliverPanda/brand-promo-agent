// 舆情雷达 · AI 选题 Agent + 打分排序（PRD FR-7 / FR-8，M3 收窄版）。
// 收窄（2026-09-04 主理人决议）：不做会商工作台（FR-9.1/9.2/9.4 移出）；保留
//   生成（每日 10 个，可手动补跑）→ 打分排序 → 一键下发 brand-promo-agent（FR-9.3 的直连版）。
// 输入上下文（FR-7.1，无 CTR——决议 2）：人设库 + 近 7 天热词榜 + 情绪摘要（负面声量）+ 订阅关键词。
// 打分（FR-8.1）：total = 0.45×热度 + 0.35×契合 + 0.20×(100−风险)，ctr 槽位预留 0%。
// 强制依据（FR-7.2）：每个选题必须引用 ≥1 个热词/声量数据，无依据不产出；全部选题过禁用词/禁忌话题过滤。
// 一致性去重（FR-7.3 本期简化）：与近 14 天已下发选题按标题精确去重（语义 embedding 留后续）。
import fs from "node:fs";
import path from "node:path";
import { getEffectiveOneApiBase, getEffectiveOneApiKey, getEffectiveProviderMode } from "../runtime-config.js";
import { oneApiPost, parseJSONSafe } from "../mastra/providers.js";
import { getPersona, personaViolations } from "./persona.js";

const DATA_DIR = process.env.PROMO_DATA_DIR || path.resolve(process.cwd(), "data");
const FILE = path.join(DATA_DIR, "radar-topics.json");
const TOPIC_COUNT = Math.max(1, Number(process.env.PROMO_RADAR_TOPIC_COUNT ?? 10));

function persistEnabled() {
  return process.env.PROMO_PERSIST !== "0";
}

/** @type {{ date: string, generatedAt: string, source: string, topics: any[], dispatched: any[] }} */
let store = { date: "", generatedAt: "", source: "", topics: [], dispatched: [] };

function hydrate() {
  if (!persistEnabled()) return;
  try {
    if (!fs.existsSync(FILE)) return;
    const j = JSON.parse(fs.readFileSync(FILE, "utf8"));
    if (j && Array.isArray(j.topics)) store = { date: j.date || "", generatedAt: j.generatedAt || "", source: j.source || "", topics: j.topics, dispatched: Array.isArray(j.dispatched) ? j.dispatched : [] };
  } catch (e) {
    console.warn("[radar-topics] hydrate 失败，忽略磁盘数据：", e?.message || e);
  }
}

function persist() {
  if (!persistEnabled()) return;
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = path.join(DATA_DIR, `.radar-topics.${process.pid}.tmp`);
    fs.writeFileSync(tmp, JSON.stringify(store, null, 2));
    fs.renameSync(tmp, FILE);
  } catch (e) {
    console.warn("[radar-topics] 持久化失败：", e?.message || e);
  }
}

hydrate();

export function topicConfig() {
  return {
    mode: getEffectiveProviderMode(),
    gatewayReady: !!(getEffectiveOneApiBase() && getEffectiveOneApiKey()),
    model: process.env.PROMO_RADAR_TOPIC_MODEL || process.env.PROMO_RADAR_NLP_MODEL || process.env.PROMO_LLM_MODEL || "deepseek-v4-flash",
    count: TOPIC_COUNT,
    weights: { heat: 0.45, fit: 0.35, risk: 0.2, ctr: 0 },
  };
}

export function todayTopics() {
  const today = new Date().toISOString().slice(0, 10);
  return store.date === today ? store : { date: today, generatedAt: "", source: "", topics: [], dispatched: store.dispatched.filter((d) => recentDispatch(d)) };
}

function recentDispatch(d) {
  const age = Date.now() - new Date(d.dispatchedAt || 0).getTime();
  return age < 14 * 24 * 3600 * 1000; // FR-7.3：近 14 天
}

export function dispatchedHistory() {
  return store.dispatched.filter(recentDispatch);
}

export function _resetTopics() {
  store = { date: "", generatedAt: "", source: "", topics: [], dispatched: [] };
}

// ── 打分（FR-8.1）：total = 0.45heat + 0.35fit + 0.20(100−risk)；ctr 预留 0% ──
export function scoreTopic(t) {
  const clamp = (v) => Math.min(100, Math.max(0, Math.round(Number(v) || 0)));
  const heat = clamp(t.heat);
  const fit = clamp(t.fit);
  const risk = clamp(t.risk); // 风险度 0~100，越高越危险 → 以 (100−risk) 正向计入
  const total = Math.round(0.45 * heat + 0.35 * fit + 0.2 * (100 - risk));
  return { heat, fit, risk, total, ctr: null };
}

// ── DEMO 确定性选题（零外部依赖、可复现；依据强制来自热词/情绪摘要） ──
const TYPE_CYCLES = ["trend", "offense", "trend", "offense", "defense", "trend", "offense", "trend", "defense", "offense"];
const TYPE_LABEL = { offense: "进攻", trend: "借势", defense: "防御" };
const FORMATS = [
  { format: "宣传片", channel: "抖音 + B站" },
  { format: "图文", channel: "小红书 + 公众号" },
  { format: "海报", channel: "微博 + 朋友圈" },
];

function demoTopics({ hotwords, sentiment, subscribedKeywords }) {
  const persona = getPersona();
  const brand = persona.brandName || "品牌";
  const product = persona.productName || "产品";
  const kws = (hotwords || []).slice(0, 8).map((h) => h.word);
  const pool = kws.length ? kws : (subscribedKeywords || []).slice(0, 5);
  if (!pool.length) pool.push(brand);
  const negHot = sentiment?.negativeVolume > 0;
  const negRatio = sentiment?.negRatio ?? 0;
  const out = [];
  for (let i = 0; i < TOPIC_COUNT; i++) {
    const w = pool[i % pool.length];
    const type = negHot && i >= TOPIC_COUNT - 2 ? "defense" : TYPE_CYCLES[i % TYPE_CYCLES.length];
    const fmt = FORMATS[i % FORMATS.length];
    let title, keyMessages;
    if (type === "offense") {
      title = `进攻选题：用 ${product} 讲透「${w}」背后的效率革命`;
      keyMessages = [`围绕热词「${w}」的实测数据`, `${persona.coreSellingPoint}`, "CTA：预约演示"];
    } else if (type === "trend") {
      title = `借势「${w}」：${brand} 视角的一周行业观察`;
      keyMessages = [`承接「${w}」热度做观点输出`, `${persona.tagline}`];
    } else {
      title = `防御性声量：正面回应「${w}」相关讨论，用实测数据说话`;
      keyMessages = [`针对「${w}」讨论的澄清与实测`, `负面声量占比 ${negRatio}%，需 4h 内响应`];
    }
    out.push({
      id: `t${i + 1}`,
      title,
      keyMessages: keyMessages.slice(0, 3),
      format: fmt.format,
      channel: fmt.channel,
      type,
      typeLabel: TYPE_LABEL[type],
      evidence: [
        { kind: "hotword", ref: w, detail: `近 7 天热词榜在榜` },
        ...(negHot && type === "defense" ? [{ kind: "sentiment", ref: "负面声量", detail: `负面 ${sentiment.negativeVolume} 条 / 占比 ${negRatio}%` }] : []),
      ],
      heat: Math.max(40, 96 - Math.floor(i * 0.9) * 7 + ((hotwords || [])[0]?.hot && i === 0 ? 4 : 0)),
      fit: type === "offense" ? 88 : type === "trend" ? 78 : 66,
      risk: type === "defense" ? 55 : type === "trend" ? 30 : 20,
    });
  }
  return out;
}

// ── LLM 选题（real + 网关已配置；失败/产出不足回落 DEMO 补齐） ──
async function llmTopics({ hotwords, sentiment, subscribedKeywords }) {
  const model = topicConfig().model;
  const persona = getPersona();
  const hw = (hotwords || []).slice(0, 10).map((h) => ({ word: h.word, score: h.score, hot: !!h.hot }));
  const sys =
    "你是品牌选题策划 Agent。基于给定人设与舆情数据产出选题，严格只输出 JSON（不含解释），" +
    `结构：{"topics":[{"title":str,"keyMessages":[≤3条],"format":"宣传片|图文|海报","channel":str,` +
    '"type":"offense|trend|defense","evidenceWords":[必须从输入热词中选，≥1个],"heat":0-100,"fit":0-100,"risk":0-100}]}。' +
    "规则：①每个选题必须引用至少一个输入热词，禁止编造数据依据；②type=offense 进攻/必打，trend 借势热词，defense 回应负面；" +
    "③全部内容避开禁用词与禁忌话题；④恰好 10 个选题。";
  const user = JSON.stringify({
    persona: { brand: persona.brandName, product: persona.productName, sellingPoint: persona.coreSellingPoint, tones: persona.tones, audience: persona.audience, bannedWords: persona.bannedWords, taboos: persona.taboos },
    hotwords: hw,
    sentiment: { negativeVolume: sentiment?.negativeVolume ?? 0, negRatio: sentiment?.negRatio ?? 0 },
    subscribedKeywords: subscribedKeywords || [],
    need: TOPIC_COUNT,
  });
  // 复用 providers 的 oneApiPost（同 base/key/超时/错误处理），失败由 generateTopics 统一回落 DEMO
  const data = await oneApiPost("/chat/completions", {
    model,
    messages: [
      { role: "system", content: sys },
      { role: "user", content: user },
    ],
    response_format: { type: "json_object" },
    temperature: 0.6,
  }, { timeoutMs: Number(process.env.PROMO_NLP_TIMEOUT_MS ?? 60000) });
  const parsed = parseJSONSafe(data?.choices?.[0]?.message?.content || "{}");
  const arr = Array.isArray(parsed?.topics) ? parsed.topics : [];
  const hotSet = new Set(hw.map((h) => h.word));
  return arr.map((t, i) => ({
    id: `t${i + 1}`,
    title: String(t.title || "").slice(0, 80),
    keyMessages: (Array.isArray(t.keyMessages) ? t.keyMessages : []).map((s) => String(s).slice(0, 60)).slice(0, 3),
    format: ["宣传片", "图文", "海报"].includes(t.format) ? t.format : "图文",
    channel: String(t.channel || "").slice(0, 40),
    type: ["offense", "trend", "defense"].includes(t.type) ? t.type : "trend",
    typeLabel: TYPE_LABEL[["offense", "trend", "defense"].includes(t.type) ? t.type : "trend"],
    // 强制依据（FR-7.2）：evidenceWords 必须来自输入热词；空/越界的丢弃，全部失效则该条淘汰
    evidence: (Array.isArray(t.evidenceWords) ? t.evidenceWords : []).filter((w) => hotSet.has(w)).map((w) => ({ kind: "hotword", ref: w, detail: "近 7 天热词榜在榜" })),
    heat: t.heat, fit: t.fit, risk: t.risk,
    model,
  })).filter((t) => t.title && t.evidence.length >= 1);
}

// 选题侧最小停用词：2-gram 分词的常见虚词残留（热词模块 M1 已知限制，此处只挡进入选题，不改热词榜）
const STOPWORDS = new Set(["相关", "以及", "可以", "我们", "大家", "这个", "那个", "最近", "有点", "怎么", "什么", "还是", "只是", "一下", "一样", "起来", "出来", "时候", "问题", "内容", "数据"]);

/**
 * 生成今日选题（每日 1 次 + 可手动补跑，覆盖当日）。
 * real 模式 LLM 产出不足 TOPIC_COUNT 的一半 → 整体回落 DEMO；否则 DEMO 模板补齐缺口。
 */
export async function generateTopics({ mentions, sentimentSummary }) {
  const persona = getPersona();
  const { computeHotwords } = await import("./hotwords.js");
  const hw = (computeHotwords(mentions || [], { range: "week" }).keywords || []).filter((h) => !STOPWORDS.has(h.word));
  const subscribedKeywords = [...new Set((mentions || []).flatMap((m) => String(m.keywordSet || "").split(/[·,，、]/)).filter(Boolean))];
  const mode = getEffectiveProviderMode();
  const gatewayReady = !!(getEffectiveOneApiBase() && getEffectiveOneApiKey());
  let topics = [];
  let source = "demo";
  let errors = [];
  if (mode === "real" && gatewayReady) {
    try {
      topics = await llmTopics({ hotwords: hw, sentiment: sentimentSummary, subscribedKeywords });
      source = "llm";
      if (topics.length < Math.ceil(TOPIC_COUNT / 2)) {
        errors.push(`LLM 仅产出 ${topics.length} 个有效选题，回落 DEMO 补齐`);
        topics = [];
        source = "demo";
      }
    } catch (e) {
      errors.push(String(e?.message || e).slice(0, 160));
      topics = [];
    }
  }
  if (topics.length < TOPIC_COUNT) {
    const seen = new Set(topics.map((t) => t.title));
    for (const t of demoTopics({ hotwords: hw, sentiment: sentimentSummary, subscribedKeywords })) {
      if (topics.length >= TOPIC_COUNT) break;
      if (!seen.has(t.title)) topics.push(t);
    }
  }
  // FR-7.3（简化版）：禁用词/禁忌话题过滤 + 近 14 天已下发标题去重
  const dispatchedTitles = new Set(dispatchedHistory().map((d) => d.title));
  topics = topics.filter((t) => {
    if (dispatchedTitles.has(t.title)) return false;
    const hit = personaViolations(t.title + (t.keyMessages || []).join(" "));
    if (hit.length) {
      errors.push(`选题「${String(t.title).slice(0, 30)}」命中禁用词/禁忌：${hit.join("、")}，已过滤`);
      return false;
    }
    return true;
  });
  topics = topics.slice(0, TOPIC_COUNT).map((t) => ({ ...t, scores: scoreTopic(t) }));
  topics.sort((a, b) => b.scores.total - a.scores.total);
  topics.forEach((t, i) => (t.rank = i + 1));
  store = { date: new Date().toISOString().slice(0, 10), generatedAt: new Date().toISOString(), source, topics, dispatched: store.dispatched };
  persist();
  return { date: store.date, generatedAt: store.generatedAt, source, topics, errors };
}

/** 选题 → Brief（FR-9.3 直连版）：人设预填 + 选题信息注入 keyMessages；parseBrief 校验在 server 侧统一做。 */
export function topicBrief(topic, { hitlEnabled = true, finalGateEnabled = true } = {}) {
  const p = getPersona();
  return {
    brandName: p.brandName,
    productName: p.productName,
    coreSellingPoint: p.coreSellingPoint,
    audience: p.audience || [],
    tones: p.tones || ["专业"],
    keyMessages: [topic.title, ...(topic.keyMessages || [])].slice(0, 5),
    durationSec: 30,
    language: p.language || "zh-CN",
    voiceTone: p.voiceTone || "男声",
    logoColor: p.logoColor || undefined,
    bannedWords: p.bannedWords || [],
    hitlEnabled,
    finalGateEnabled,
  };
}

/** 登记下发（去重历史 + 生命周期留痕 FR-10.2）。 */
export function recordDispatch(topicId, runId) {
  const t = store.topics.find((x) => x.id === topicId);
  if (!t) throw new Error("选题不存在或已过期（请重新生成）");
  store.dispatched.push({ topicId, title: t.title, type: t.type, runId, dispatchedAt: new Date().toISOString() });
  persist();
  return t;
}
