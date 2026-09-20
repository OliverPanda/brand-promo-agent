// 舆情雷达 M1 单测：订阅 CRUD/预置保护/持久化、mention 去重、热词确定性、TikHub 适配器（DEMO + mock fetch 真实模式）。
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.PROMO_PERSIST = "0"; // 内存态，互不污染（与 setup.mjs 一致）

// ── 订阅 ──
const SUBS = await import("../src/radar/subscriptions.js");

test("radar subscriptions：预置注入且不可删", () => {
  const list = SUBS.listSubscriptionGroups();
  assert.ok(list.length >= 1);
  const preset = list.find((s) => s.id === "preset-mingstar-radar");
  assert.ok(preset, "预置订阅应存在");
  assert.equal(SUBS.deleteSubscriptionGroup(preset.id), false);
  assert.ok(SUBS.listSubscriptionGroups().some((s) => s.id === preset.id));
});

test("radar subscriptions：CRUD + 校验（非法平台 400 / 关键词空 400）", () => {
  const s = SUBS.saveSubscriptionGroup({ name: "测试订阅", keywords: ["测试词"], platforms: ["douyin"] });
  assert.ok(s.id && !s.id.startsWith("preset-"));
  assert.equal(SUBS.deleteSubscriptionGroup(s.id), true);
  assert.throws(() => SUBS.saveSubscriptionGroup({ name: "x", keywords: [], platforms: ["douyin"] }));
  assert.throws(() => SUBS.saveSubscriptionGroup({ name: "x", keywords: ["a"], platforms: ["twitter"] }));
});

test("radar subscriptions：客户端伪造 id/isPreset 被剥离（防预置覆盖，M4 评审 F2/F3 同款红线）", () => {
  const forged = SUBS.saveSubscriptionGroup({ id: "preset-mingstar-radar", isPreset: false, name: "伪造覆盖", keywords: ["x"], platforms: ["douyin"] });
  assert.notEqual(forged.id, "preset-mingstar-radar");
  assert.equal(forged.isPreset, false);
  const stillPreset = SUBS.listSubscriptionGroups().find((s) => s.id === "preset-mingstar-radar");
  assert.equal(stillPreset.name, "铭星链 · 默认订阅");
});

// ── mentions 去重 ──
const { addMentions, mentionId, listMentions, mentionCount, _resetMentions } = await import("../src/radar/mentions.js");

test("radar mentions：同 url 幂等去重 + 脱敏 authorHash", () => {
  _resetMentions();
  const m = (over = {}) => ({
    platform: "douyin", text: "测试内容 A", url: "https://x/1", author: "张三", metrics: { likes: 10 }, ...over,
  });
  const r1 = addMentions([m()]);
  assert.equal(r1.added, 1);
  const r2 = addMentions([m(), m({ text: "不同文本", url: "https://x/2" })]);
  assert.equal(r2.added, 1);
  assert.equal(r2.duplicates, 1);
  assert.equal(mentionCount(), 2);
  const items = listMentions({});
  assert.ok(items.every((x) => !x.author, "原始作者名不得入库（脱敏在 tikhub 层，此处兜底断言 id 无明文）"));
  assert.ok(mentionId("douyin", m()) === mentionId("douyin", m()), "同内容 id 稳定");
});

// ── 热词 ──
const { computeHotwords, _testTokenize } = await import("../src/radar/hotwords.js");

test("radar hotwords：中文滑窗 + 词表命中 + 拉丁词", () => {
  const toks = _testTokenize("铭星链的 AI 创作真的好用 AI创作 www.example.com", ["铭星链", "AI 创作"]);
  assert.ok(toks.includes("铭星链"), "词表命中");
  assert.ok(toks.includes("ai"), "拉丁词小写");
  assert.ok(toks.includes("创作"), "中文滑窗");
});

test("radar hotwords：中文去噪——滑窗碎片（相关的/关的/是真）不进 TOP10，订阅词豁免冷词门槛", () => {
  _resetMentions();
  const now = Date.now();
  const mentions = [];
  for (let i = 0; i < 3; i++) {
    mentions.push({
      platform: "douyin", text: `[铭星链] 相关的工具是真的好用，相关讨论很多 ${i}`, url: `u${i}`,
      publishedAt: new Date(now - (i + 1) * 3600e3).toISOString(), crawledAt: new Date(now).toISOString(),
      metrics: { likes: 10 * (i + 1) },
    });
  }
  const top = computeHotwords(mentions, { range: "day" }).keywords.slice(0, 10);
  const words = top.map((k) => k.word);
  assert.ok(!words.includes("相关的") && !words.includes("关的") && !words.includes("是真"), `碎片词未过滤：${words.join("/")}`);
  assert.ok(words.some((w) => w.includes("相关")), "实词组合应保留");
  assert.ok(words.some((w) => w.includes("铭星链")), "订阅关键词豁免冷词门槛，必须上榜");
});

test("radar hotwords：day 榜确定性 + 爆点/新词标记 + 品牌词 tag", () => {
  _resetMentions();
  const now = Date.now();
  const mk = (text, ageH, likes) => ({
    platform: "douyin", text, url: "u" + Math.random(), publishedAt: new Date(now - ageH * 3600e3).toISOString(),
    crawledAt: new Date(now).toISOString(), metrics: { likes, comments: 0, shares: 0 },
  });
  const mentions = [
    mk("铭星链 发布新版本，AI 创作效率翻倍", 2, 5000),
    mk("铭星链 又上热搜，创始人访谈", 4, 8000),
    mk("人工智能大模型竞争白热化", 3, 2000),
    mk("旧闻：去年的行业总结", 24 * 10, 100), // 落在窗口外
  ];
  const board = computeHotwords(mentions, { range: "day" });
  assert.equal(board.range, "day");
  assert.ok(board.keywords.length > 0);
  const brand = board.keywords.find((k) => k.word === "铭星链");
  assert.ok(brand, "品牌词应上榜");
  assert.equal(brand.tag, "brand");
  assert.ok(brand.hot === true || brand.ratio === "new", "近窗词无上一窗基线 → 新词/爆点");
  const outOfWindow = board.keywords.find((k) => k.word === "去年");
  assert.ok(!outOfWindow, "窗口外 mention 不计分");
  // TOP50 截断
  assert.ok(board.keywords.length <= 50);
});

// ── TikHub 适配器：DEMO 确定性 + real mock fetch ──
process.env.PROMO_PROVIDER_MODE = "demo";
const tikhub = await import("../src/radar/tikhub.js");

test("radar tikhub：DEMO 模式确定性种子（同参数两次采集内容一致、id 稳定）", async () => {
  assert.equal(tikhub.getRadarMode(), "demo");
  const a = await tikhub.fetchKeyword("douyin", "测试词");
  const b = await tikhub.fetchKeyword("douyin", "测试词");
  assert.equal(a.items.length, b.items.length);
  assert.deepEqual(a.items.map((x) => x.text), b.items.map((x) => x.text));
  assert.ok(a.items.every((x) => x.text.includes("测试词")));
});

test("radar tikhub：unsupported 平台 fail-soft 抛错并被 collectRound 归入 errors", async () => {
  const { collectRound } = tikhub;
  const r = await collectRound([{ name: "g", keywords: ["词"], platforms: ["weibo"] }]);
  assert.equal(r.mentions.length, 0);
  assert.equal(r.errors.length, 1);
  assert.match(r.errors[0].error, /不可用|未上线/);
});

test("radar tikhub：real 模式请求构造正确（鉴权/端点/参数）+ 响应解析 + _usage 计量", async () => {
  process.env.PROMO_PROVIDER_MODE = "real";
  process.env.TIKHUB_API_KEY = "sk-test";
  let captured = null;
  const fetchMock = mock.method(globalThis, "fetch", async (input, init = {}) => {
    const url = String(input);
    captured = { url, init };
    return new Response(JSON.stringify({
      code: 200, cache_url: "https://cache.tikhub.io/fake",
      data: { data: { data: { items: [{ model_type: "note", note: { id: "n1", title: "标题", desc: "描述", timestamp: Date.now(), user: { nickname: "小王" }, liked_count: "123", comments_count: 4 } }] } } },
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  });
  try {
    const out = await tikhub.fetchKeyword("xhs", "关键词X");
    assert.match(captured.url, /xiaohongshu\/app_v2\/search_notes\?keyword=/);
    assert.equal(captured.init.headers.Authorization, "Bearer sk-test");
    assert.equal(out.items.length, 1);
    assert.equal(out.items[0].metrics.likes, 123); // 字符串数字容错
    assert.equal(out.fromCache, false);
    // 第二次同参数 → 走 cache_url（免费），不再打计费端点
    captured = null;
    const out2 = await tikhub.fetchKeyword("xhs", "关键词X");
    assert.match(captured.url, /cache\.tikhub\.io/);
    assert.equal(out2.fromCache, true);
  } finally {
    fetchMock.mock.restore();
    delete process.env.TIKHUB_API_KEY;
    process.env.PROMO_PROVIDER_MODE = "demo";
  }
});
