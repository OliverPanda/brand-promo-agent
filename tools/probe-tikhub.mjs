// TikHub 只读探针（舆情雷达 PRD §11 决议 1 / FR-1.2）。
// 用途：验证 TIKHUB_API_KEY 鉴权与配额；对拍各平台搜索端点的真实响应结构（供适配器校准）。
// 用法：
//   node tools/probe-tikhub.mjs                # 只读：账户信息 + 端点清单（零费用或最小费用）
//   node tools/probe-tikhub.mjs --live weibo   # 实测一个平台搜索端点（会产生 1 次 TikHub 计费请求）
// 端点矩阵（2026-09-04 对拍 data/_tikhub-openapi.json，1066 paths）：
//   配额  GET /api/v1/tikhub/user/get_user_info
//   微博  GET /api/v1/weibo/web/fetch_search?keyword&search_type&time_scope
//   B站   GET /api/v1/bilibili/web/fetch_general_search?keyword&order&page&page_size
//   小红书 GET /api/v1/xiaohongshu/app_v2/search_notes?keyword&page
//   抖音  POST /api/v1/douyin/search/fetch_general_search_v2  body:{keyword,sort_type,publish_time,cursor}
//   热榜  GET /api/v1/weibo/web/fetch_hot_search | GET /api/v1/douyin/web/fetch_hot_search_result
const BASE = process.env.TIKHUB_BASE_URL || "https://api.tikhub.io";
const KEY = process.env.TIKHUB_API_KEY || "";

async function api(path, { method = "GET", body, label } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      Authorization: `Bearer ${KEY}`,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30000),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* 保留原文 */ }
  console.log(`\n### ${label || path} → HTTP ${res.status}`);
  const out = json ?? text;
  const s = JSON.stringify(out);
  console.log(s.length > 2500 ? s.slice(0, 2500) + ` …(共 ${s.length} 字符，已截断)` : s);
  return { status: res.status, json };
}

async function main() {
  if (!KEY) {
    console.error("缺少 TIKHUB_API_KEY（复制 .env.example 为 .env 后填写）。");
    process.exit(1);
  }
  console.log("TikHub 探针 →", BASE);

  // 1) 账户与配额（免费）
  const me = await api("/api/v1/tikhub/user/get_user_info", { label: "账户信息/配额" });
  if (me.status !== 200) {
    console.error("鉴权失败：检查 TIKHUB_API_KEY。");
    process.exit(1);
  }

  // 2) 可选：实测一个平台搜索端点（产生 1 次计费请求）
  const live = process.argv.includes("--live") ? process.argv[process.argv.indexOf("--live") + 1] : null;
  const kw = process.argv.includes("--kw") ? process.argv[process.argv.indexOf("--kw") + 1] : "人工智能";
  if (live === "weibo") {
    await api(`/api/v1/weibo/web/fetch_search?keyword=${encodeURIComponent(kw)}&search_type=1`, { label: `微博搜索 "${kw}"` });
  } else if (live === "bilibili") {
    await api(`/api/v1/bilibili/web/fetch_general_search?keyword=${encodeURIComponent(kw)}&order=totalrank&page=1&page_size=20`, { label: `B站搜索 "${kw}"` });
  } else if (live === "xiaohongshu") {
    await api(`/api/v1/xiaohongshu/app_v2/search_notes?keyword=${encodeURIComponent(kw)}`, { label: `小红书搜索 "${kw}"` });
  } else if (live === "douyin") {
    await api("/api/v1/douyin/search/fetch_general_search_v2", {
      method: "POST",
      body: { keyword: kw, sort_type: "0", publish_time: "7", cursor: 0 },
      label: `抖音综合搜索 "${kw}"（近一周）`,
    });
  } else if (live === "hotlist") {
    await api("/api/v1/weibo/web/fetch_hot_search", { label: "微博热搜榜" });
    await api("/api/v1/douyin/web/fetch_hot_search_result", { label: "抖音热点榜" });
  } else if (live) {
    console.error(`未知平台 "${live}"，可选：weibo | bilibili | xiaohongshu | douyin | hotlist`);
    process.exit(1);
  } else {
    console.log("\n（只读模式结束；加 --live <weibo|bilibili|xiaohongshu|douyin|hotlist> --kw <关键词> 实测计费端点）");
  }
}

main().catch((e) => {
  console.error("探针失败：", e?.message || e);
  process.exit(1);
});
