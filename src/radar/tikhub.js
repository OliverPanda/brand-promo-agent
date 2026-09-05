// 舆情雷达 · TikHub 采集适配器（PRD FR-1）。
// 端点矩阵（2026-09-04 探针 data/_tikhub-openapi.json + 实测 200 校准）：
//   douyin  POST /api/v1/douyin/search/fetch_general_search_v2   body:{keyword,sort_type:"0",publish_time:"7",cursor:0}
//           → data.data.business_data[] → item.data(可JSON字符串).aweme_info{desc,create_time,author.nickname,statistics{...},share_url}
//   xhs     GET  /api/v1/xiaohongshu/app_v2/search_notes?keyword&page
//           → data.data.data.items[] → .note{id,title,display_title,desc,timestamp,user.nickname,liked_count,comments_count,shared_count,collected_count}
//   bilibili GET /api/v1/bilibili/web/fetch_general_search?keyword&order=totalrank&page=1&page_size=20
//           → data.data.data.result[] → {title,description,arcurl,uname,pubdate|senddate,like,play,danmaku,reviews}
//   weibo   GET  /api/v1/weibo/web/fetch_search —— 探针实测 404（TikHub 路由未上线），标记 unsupported，fail-soft 跳过。
// 成本策略（FR-1.3）：TikHub 同参数响应带 24h 免费 cache_url（计费请求响应内返回）——
//   适配器按「平台+关键词」缓存 cache_url，TTL 内轮询改走缓存链接（零计费），失败回落计费端点。
// DEMO 模式（getRadarMode()!=="real"）：确定性种子数据，零外部依赖、内容可复现（id 基于内容指纹）。
import { hashId } from "./mentions.js";
import { getEffectiveProviderMode } from "../runtime-config.js";

const BASE = process.env.TIKHUB_BASE_URL || "https://api.tikhub.io";
const QPS_GAP_MS = Number(process.env.PROMO_RADAR_QPS_GAP_MS ?? 1100); // 单平台最小请求间隔（QPS ≤ 1，FR-1.3）

export function getRadarMode() {
  // 页面运行时配置可切换 real；不能只读进程环境，否则前端显示 real 而采集仍悄悄使用 DEMO 种子。
  const mode = getEffectiveProviderMode();
  return mode === "real" && process.env.TIKHUB_API_KEY ? "real" : "demo";
}

// ── 24h 免费 cache_url 缓存（仅 real 模式） ──
/** @type {Map<string, {url:string, expiresAt:number}>} */
const cacheUrls = new Map();

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** 单平台节流：确保同平台两次计费请求间隔 ≥ QPS_GAP_MS（内存级，够用）。 */
const lastCall = new Map();
async function throttle(platform) {
  const last = lastCall.get(platform) || 0;
  const wait = last + QPS_GAP_MS - Date.now();
  if (wait > 0) await sleep(wait);
  lastCall.set(platform, Date.now());
}

async function tikhubRequest(path, { method = "GET", body } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      Authorization: `Bearer ${process.env.TIKHUB_API_KEY || ""}`,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30000),
  });
  const json = await res.json().catch(() => null);
  if (!res.ok) {
    const msg = json?.detail?.message_zh || json?.detail?.message || json?.detail || `HTTP ${res.status}`;
    throw new Error(typeof msg === "string" ? msg : JSON.stringify(msg).slice(0, 200));
  }
  return json;
}

// ── 各平台字段提取（按实测结构，缺字段安全回落） ──

function extractDouyin(json) {
  const bd = json?.data?.data?.business_data || [];
  const out = [];
  for (const item of bd) {
    let inner = item?.data ?? {};
    if (typeof inner === "string") {
      try { inner = JSON.parse(inner); } catch { continue; }
    }
    const a = inner?.aweme_info;
    if (!a || !a.desc) continue;
    out.push({
      text: a.desc,
      author: a.author?.nickname || "",
      publishedAt: a.create_time ? new Date(a.create_time * 1000).toISOString() : "",
      url: a.share_url || "",
      metrics: {
        likes: a.statistics?.digg_count || 0,
        comments: a.statistics?.comment_count || 0,
        shares: a.statistics?.share_count || 0,
      },
      externalId: a.aweme_id || a.statistics?.aweme_id || "",
    });
  }
  return out;
}

function extractXhs(json) {
  const items = json?.data?.data?.data?.items || [];
  const out = [];
  for (const item of items) {
    const n = item?.note;
    if (!n || (!n.title && !n.desc)) continue;
    out.push({
      text: [n.title, n.display_title, n.desc].filter(Boolean).join(" "),
      author: n.user?.nickname || "",
      publishedAt: n.timestamp ? new Date(Number(n.timestamp)).toISOString() : "",
      url: n.id ? `https://www.xiaohongshu.com/explore/${n.id}` : "",
      metrics: {
        likes: Number(n.liked_count) || 0,
        comments: Number(n.comments_count) || 0,
        shares: Number(n.shared_count) || 0,
      },
      externalId: n.id || "",
    });
  }
  return out;
}

function extractBilibili(json) {
  const result = json?.data?.data?.data?.result || [];
  const out = [];
  for (const r of result) {
    if (!r || (!r.title && !r.description)) continue;
    const ts = Number(r.pubdate || r.senddate || 0);
    out.push({
      text: [r.title, r.description].filter(Boolean).join(" "),
      author: r.uname || r.author || "",
      publishedAt: ts ? new Date(ts * 1000).toISOString() : "",
      url: r.arcurl || "",
      metrics: {
        likes: Number(r.like) || 0,
        comments: Number(r.review) || 0,
        shares: 0,
        extra: { play: Number(r.play) || 0, favorites: Number(r.favorites) || 0 },
      },
      externalId: String(r.id || r.aid || r.bvid || ""),
    });
  }
  return out;
}

// 平台适配表：buildRequest(keyword) + extract(json)。weibo 路由未上线 → unsupported。
export const PLATFORMS = {
  douyin: {
    label: "抖音",
    request: (keyword) => ({
      path: "/api/v1/douyin/search/fetch_general_search_v2",
      method: "POST",
      body: { keyword, sort_type: "0", publish_time: "7", cursor: 0 },
    }),
    extract: extractDouyin,
  },
  xhs: {
    label: "小红书",
    request: (keyword) => ({
      path: `/api/v1/xiaohongshu/app_v2/search_notes?keyword=${encodeURIComponent(keyword)}&page=1`,
    }),
    extract: extractXhs,
  },
  bilibili: {
    label: "B站",
    request: (keyword) => ({
      path: `/api/v1/bilibili/web/fetch_general_search?keyword=${encodeURIComponent(keyword)}&order=totalrank&page=1&page_size=20`,
    }),
    extract: extractBilibili,
  },
  weibo: {
    label: "微博",
    unsupported: "TikHub 路由未上线（探针 404）",
  },
};

/**
 * 抓取单个（平台 × 关键词）：
 * real 模式优先走 24h cache_url（零计费），失效再打计费端点并更新缓存；DEMO 走确定性种子。
 * 返回标准化 mention 数组（不含 id/去重——由 mentions.js 负责）。
 */
export async function fetchKeyword(platform, keyword) {
  const adapter = PLATFORMS[platform];
  if (!adapter) throw new Error(`未知平台 ${platform}`);
  if (adapter.unsupported) throw new Error(`平台 ${platform} 暂不可用：${adapter.unsupported}`);

  if (getRadarMode() !== "real") return { items: demoMentions(platform, keyword), fromCache: false };

  const cacheKey = `${platform}:${keyword}`;
  const cached = cacheUrls.get(cacheKey);
  // ① 24h 内有缓存链接 → 免费拉取（零计费）
  if (cached && cached.expiresAt > Date.now()) {
    try {
      const r = await fetch(cached.url, { signal: AbortSignal.timeout(30000) });
      if (r.ok) {
        const json = await r.json();
        return { items: adapter.extract(json), fromCache: true };
      }
    } catch { /* 缓存失败回落计费端点 */ }
  }
  // ② 计费端点
  await throttle(platform);
  const req = adapter.request(keyword);
  const json = await tikhubRequest(req.path, { method: req.method, body: req.body });
  if (json?.cache_url) {
    cacheUrls.set(cacheKey, { url: json.cache_url, expiresAt: Date.now() + 24 * 3600 * 1000 });
  }
  return { items: adapter.extract(json), fromCache: false };
}

/**
 * 一轮采集：遍历订阅 × 关键词 × 平台。
 * 返回 { mentions, requests, errors }（mentions 为标准化数组，去重交给 mentions.js）。
 */
export async function collectRound(groups, { platforms: platformFilter } = {}) {
  const mode = getRadarMode();
  const mentions = [];
  const errors = [];
  let requests = 0;
  const jobs = [];
  for (const g of groups) {
    for (const kw of g.keywords || []) {
      for (const p of g.platforms || []) {
        if (platformFilter && !platformFilter.includes(p)) continue;
        jobs.push({ platform: p, keyword: kw, group: g.name });
      }
    }
  }
  const seen = new Set(); // 同轮内 (平台,关键词) 去重（多订阅重叠词只采一次）
  for (const job of jobs) {
    const key = `${job.platform}:${job.keyword}`;
    if (seen.has(key)) continue;
    seen.add(key);
    try {
      const result = await fetchKeyword(job.platform, job.keyword);
      const items = Array.isArray(result) ? result : result.items;
      // requests 口径 = TikHub 计费调用数（DEMO 种子与 cache_url 命中均零计费）
      if (mode === "real" && result && !Array.isArray(result) && result.fromCache === false) requests += 1;
      for (const it of items) {
        mentions.push({
          platform: job.platform,
          keywordSet: job.group,
          text: String(it.text || "").slice(0, 2000),
          authorHash: it.author ? "a:" + hashId(it.author).slice(0, 10) : "a:anon", // 脱敏（FR-1.6）
          publishedAt: it.publishedAt || "",
          url: it.url || "",
          metrics: it.metrics || {},
          externalId: it.externalId || "",
          _usage: mode === "real" ? { requests: 1 } : undefined,
        });
      }
    } catch (e) {
      errors.push({ platform: job.platform, keyword: job.keyword, error: String(e?.message || e).slice(0, 160) });
    }
  }
  return { mentions, requests, errors, mode };
}

// ── DEMO 确定性种子（零外部依赖，内容可复现；id 基于内容指纹 → 去重行为与真实一致） ──
const DEMO_TEMPLATES = [
  (kw) => `深度体验了 ${kw} 相关的新工具，效率提升是真的明显，分享一下使用心得和踩坑记录。`,
  (kw) => `【讨论】${kw} 这个赛道最近有点卷，大家怎么看未来一年的走向？评论区聊聊。`,
  (kw) => `${kw} 又双叒上热搜了！这次的事件梳理与来龙去脉，一条视频讲清楚。`,
  (kw) => `避雷帖：${kw} 相关的这几个坑千万别踩，全是真金白银换来的教训。`,
  (kw) => `盘点 2026 年 ${kw} 领域最值得关注的 5 个变化，第 3 个很多人还没意识到。`,
  (kw) => `实测对比：主流 ${kw} 方案横评，数据说话，结果有点出乎意料。`,
];

export function demoMentions(platform, keyword, round = 0) {
  const out = [];
  // 确定性：每关键词 × 平台产 5 条；文本固定模板；时间偏移固定 → 权重稳定可测
  for (let i = 0; i < 5; i++) {
    const tpl = DEMO_TEMPLATES[(i + round) % DEMO_TEMPLATES.length];
    const text = tpl(keyword);
    const ageHours = 2 + i * 6 + (round % 3) * 24; // 2h ~ 3天+，跨日便于环比
    out.push({
      text: `[${keyword}] ${text}`,
      author: `demo_${platform}_${i}`,
      publishedAt: new Date(Date.now() - ageHours * 3600 * 1000).toISOString(),
      url: `https://demo.tikhub.local/${platform}/${hashId(keyword + i)}`,
      metrics: { likes: (i + 1) * 137 + keyword.length * 11, comments: (i + 1) * 21, shares: (i + 1) * 5 },
      externalId: `demo-${hashId(platform + keyword + i + round)}`,
    });
  }
  return out;
}
