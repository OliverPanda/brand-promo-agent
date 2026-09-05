// 舆情雷达 · 热词计算（PRD FR-2）。
// 口径（可解释、确定性）：score(word) = Σ over mentions [ freq × interactionWeight × timeDecay ]
//   - 分词：拉丁词按 [a-zA-Z0-9]+ 切；中文取自定义词表命中（订阅关键词 + STOPWORDS 之外的 2~4 字滑窗去停用词）
//   - interactionWeight = 1 + log10(1 + likes + comments + shares)（互动加权，log 防爆榜）
//   - timeDecay = 0.5 ^ (ageHours / HALF_LIFE_H)，半衰期 24h
// 榜单：day=近24h / week=近7d，TOP50；环比 = 本窗分值 / 上一窗分值（上一窗为 0 → ∞ 记 "new"）；
//   爆点标记（FR-2.3）：环比 > 300%（即 ratio > 3）。
// 品牌词标记：命中订阅关键词的词条 tag="brand"/"competitor"（词表前缀约定），否则 "industry"。
import { allKeywords } from "./subscriptions.js";

const HALF_LIFE_H = 24;
const TOP_N = 50;
const STOPWORDS = new Set([
  "的", "了", "是", "在", "我", "有", "和", "就", "不", "人", "都", "一", "一个", "上", "也", "很", "到", "说", "要", "去", "你", "会", "着",
  "没有", "看", "好", "自己", "这", "那", "这个", "那个", "什么", "怎么", "如果", "还是", "但是", "因为", "所以", "可以", "我们", "他们",
  "the", "and", "for", "are", "but", "not", "you", "all", "can", "with", "this", "that", "www", "com", "http", "https",
]);

function tokenize(text, wordlist) {
  const tokens = [];
  const lower = String(text || "").toLowerCase();
  // 1) 拉丁词
  for (const m of lower.matchAll(/[a-z0-9][a-z0-9+#.-]{1,20}/g)) {
    const w = m[0].replace(/[.+#-]+$/, "");
    if (w.length >= 2 && !STOPWORDS.has(w)) tokens.push(w);
  }
  // 2) 词表命中（订阅关键词，长短语优先）
  for (const kw of wordlist) {
    const k = kw.toLowerCase();
    if (k.length >= 2 && lower.includes(k)) tokens.push(k);
  }
  // 3) 中文 2-gram（步长 2、不重叠）＋首尾虚词过滤。
  //    实测：逐字滑窗（step=1）会产生「赛道最近 / 近有点卷 / 大家怎么」这类同源重叠碎片集体霸榜，
  //    step=2 不重叠后同源片段大幅减少，可读性显著提升；长实体靠词表命中（订阅关键词）与冷词豁免兜底。
  for (const m of lower.matchAll(/[\u4e00-\u9fa5]{2,}/g)) {
    const seg = m[0];
    for (let i = 0; i + 2 <= seg.length; i += 2) {
      const w = seg.slice(i, i + 2);
      if (!STOPWORDS.has(w) && !isJunkCjk(w)) tokens.push(w);
    }
  }
  return tokens;
}

function interactionWeight(m) {
  const mt = m.metrics || {};
  const engagement = (mt.likes || 0) + (mt.comments || 0) + (mt.shares || 0);
  return 1 + Math.log10(1 + engagement);
}

function timeDecay(iso) {
  if (!iso) return 0.5; // 无时间戳按半衰期对待
  const ageH = Math.max(0, (Date.now() - new Date(iso).getTime()) / 3600_000);
  return Math.pow(0.5, ageH / HALF_LIFE_H);
}

function bucketScore(mentions, wordlist, windowHours) {
  const scores = new Map(); // word -> {score, count}
  const since = Date.now() - windowHours * 3600_000;
  for (const m of mentions) {
    const published = m.publishedAt ? new Date(m.publishedAt).getTime() : new Date(m.crawledAt).getTime();
    if (published < since) continue;
    for (const w of new Set(tokenize(m.text, wordlist))) {
      // 同条 mention 同词只计一次（防止长文刷词频），权重取条级
      const s = interactionWeight(m) * timeDecay(m.publishedAt || m.crawledAt);
      const prev = scores.get(w) || { score: 0, count: 0 };
      prev.score += s;
      prev.count += 1;
      scores.set(w, prev);
    }
  }
  return scores;
}

// 无分词库下的中文去噪（实测必须项：裸 2~4 滑窗会让「相关 / 关的 / 相关的」这类碎片霸榜）：
//  ① 首尾虚词过滤：中文词首/尾命中虚词（的、了、是、真…）直接丢弃；
//  ② 子串抑制：长词与子串出现次数接近（≥80%）→ 丢弃子串，保留更完整的长词；
//  ③ 冷词门槛：中文词仅出现 1 次视为噪音丢弃（订阅关键词豁免，品牌词必须能上榜）。
const VIRTUAL_CHARS = new Set(
  "的了是在和有也就很都而及与或把被让给从对为以其之于则且还又更最这那你我他她它们个些吧呢啊吗不没无真好再多去来上下里中后前说做用得到过会能要可"
);

function isCjk(w) {
  return /^[\u4e00-\u9fa5]+$/.test(w);
}

function isJunkCjk(w) {
  return isCjk(w) && (VIRTUAL_CHARS.has(w[0]) || VIRTUAL_CHARS.has(w[w.length - 1]));
}

function suppressSubstrings(counts) {
  const words = [...counts.keys()].sort((a, b) => b.length - a.length);
  const drop = new Set();
  for (const long of words) {
    if (drop.has(long) || !isCjk(long)) continue;
    const cLong = counts.get(long) || 0;
    // 子串必须真比长词短、且不越界（否则 i>0 时恒不满足 → 死循环）
    for (let i = 0; i + 2 <= long.length; i++) {
      for (let n = 2; i + n <= long.length && n < long.length; n++) {
        const sub = long.slice(i, i + n);
        const cSub = counts.get(sub) || 0;
        if (cLong > 0 && cSub >= cLong * 0.8) drop.add(sub);
      }
    }
  }
  return drop;
}

/**
 * 计算热词榜。
 * @param {Array} mentions 全量 mention（由 server 传入 allMentions()）
 * @param {{range?: 'day'|'week'}} opts
 * 返回 { range, updatedAt, keywords: [{word, tag, score, count, ratio, hot}] TOP50 }
 */
export function computeHotwords(mentions, opts = {}) {
  const range = opts.range === "week" ? "week" : "day";
  const windowHours = range === "week" ? 24 * 7 : 24;
  const subsKeywords = allKeywords();
  // 词表优先级：订阅关键词（>=2字）参与 brand/industry 标记
  const wordlist = [...new Set(subsKeywords.filter((k) => k.length >= 2))];
  const kwMeta = new Map(wordlist.map((k) => [k.toLowerCase(), k]));

  const current = bucketScore(mentions, wordlist, windowHours);
  // 环比基线：上一窗（时间轴向回退一个窗）
  const prevScores = new Map();
  {
    const since = Date.now() - 2 * windowHours * 3600_000;
    const until = Date.now() - windowHours * 3600_000;
    const prevWindow = mentions.filter((m) => {
      const t = m.publishedAt ? new Date(m.publishedAt).getTime() : new Date(m.crawledAt).getTime();
      return t >= since && t < until;
    });
    for (const m of prevWindow) {
      for (const w of new Set(tokenize(m.text, wordlist))) {
        const s = interactionWeight(m);
        prevScores.set(w, (prevScores.get(w) || 0) + s);
      }
    }
  }

  // 去噪 ①②③：先按原始计数算抑制集与冷词，再生成榜单
  const rawCounts = new Map([...current].map(([w, v]) => [w, v.count]));
  const junkDrop = suppressSubstrings(rawCounts);
  const rows = [];
  for (const [word, { score, count }] of current) {
    if (isJunkCjk(word) || junkDrop.has(word)) continue;
    if (isCjk(word) && count < 2 && !wordlist.some((k) => k.toLowerCase() === word)) continue;
    // 词条归类：命中订阅关键词的标 brand，其余 industry（competitor 待竞品词表后续期引入）
    let tag = "industry";
    for (const k of wordlist) {
      const kl = k.toLowerCase();
      if (word === kl || (kl.length >= 2 && word.includes(kl))) { tag = "brand"; break; }
    }
    const prev = prevScores.get(word) || 0;
    const ratio = prev > 0 ? score / prev : Infinity;
    const hot = prev === 0 || ratio > 3; // FR-2.3 爆点：环比 > 300% 或纯新词
    rows.push({
      word,
      tag,
      isSubscribedKeyword: kwMeta.has(word.toLowerCase()),
      score: Math.round(score * 1000) / 1000,
      count,
      ratio: ratio === Infinity ? "new" : Math.round(ratio * 100) / 100,
      hot,
    });
  }
  rows.sort((a, b) => b.score - a.score);
  return {
    range,
    windowHours,
    updatedAt: new Date().toISOString(),
    keywords: rows.slice(0, TOP_N),
  };
}

// 仅测试用
export function _testTokenize(text, wordlist = []) {
  return tokenize(text, wordlist);
}
