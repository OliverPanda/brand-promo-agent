// 舆情雷达 · LLM 情绪打分测试（M2 收窄版）：DEMO 确定性 / 指纹缓存 / 聚合口径 / LLM 批量+每日预算降级 / 失败兜底 / server e2e。
import { test, mock } from "node:test";
import assert from "node:assert/strict";

process.env.PROMO_PERSIST = "0";
delete process.env.PROMO_PROVIDER_MODE; // 默认 DEMO
process.env.PROMO_NLP_BATCH_SIZE = "2"; // 强制小批，验证分批
process.env.PROMO_NLP_DAILY_CAP = "2"; // 今日 LLM 预算 2 条（第 1 批用满 → 第 2 批验证超限降级）

const sentiment = await import("../src/radar/sentiment.js");
const { app } = await import("../src/server.js");

function listen(app) {
  return new Promise((resolve) => {
    const srv = app.listen(0, () => resolve(srv));
  });
}

test("DEMO 确定性打分：特征词 → pos/neu/neg，confidence 0.9", async () => {
  sentiment._resetSentiment();
  const mentions = [
    { id: "d1", text: "又双叒翻车了，这波操作真是让人大开眼界", platform: "douyin", crawledAt: new Date().toISOString() },
    { id: "d2", text: "深度体验后效率提升是真的明显，推荐", platform: "xhs", crawledAt: new Date().toISOString() },
    { id: "d3", text: "【讨论】这个赛道最近有点卷，大家怎么看？", platform: "bilibili", crawledAt: new Date().toISOString() },
  ];
  const stats = await sentiment.scorePendingMentions(mentions);
  assert.equal(stats.mode, "demo");
  assert.equal(stats.demoScored, 3);
  const s1 = sentiment.getScore("d1");
  assert.equal(s1.sentiment, "neg", "反讽文本应判负面");
  assert.equal(s1.source, "demo");
  assert.ok(s1.score < 0 && s1.confidence >= 0.6);
  assert.equal(sentiment.getScore("d2").sentiment, "pos");
  assert.equal(sentiment.getScore("d3").sentiment, "neu");
});

test("指纹缓存：同内容二次打分 pending=0，零重复计算", async () => {
  const mentions = [
    { id: "d1", text: "又双叒翻车了", platform: "douyin", crawledAt: new Date().toISOString() },
    { id: "d9", text: "新内容一条", platform: "douyin", crawledAt: new Date().toISOString() },
  ];
  const stats = await sentiment.scorePendingMentions(mentions);
  assert.equal(stats.pending, 1, "d1 已打分走缓存跳过，仅 d9 待打分");
  assert.equal(stats.cacheSkipped, 1);
  assert.equal(stats.demoScored, 1);
});

test("聚合摘要：严格负面口径 = neg 且 confidence ≥ 0.6；情绪指数 0~100", async () => {
  const mentions = [
    { id: "d1", platform: "douyin", crawledAt: new Date().toISOString() },
    { id: "d2", platform: "xhs", crawledAt: new Date().toISOString() },
    { id: "d3", platform: "bilibili", crawledAt: new Date().toISOString() },
  ];
  const sum = sentiment.sentimentSummary(mentions);
  assert.equal(sum.scored, 3);
  assert.equal(sum.neg, 1);
  assert.equal(sum.pos, 1);
  assert.equal(sum.neu, 1);
  assert.equal(sum.negativeVolume, 1, "demo confidence 0.9 ≥ 0.6，计入严格负面声量");
  assert.equal(sum.negRatio, 33.3);
  assert.ok(sum.index >= 0 && sum.index <= 100);
  assert.equal(sum.unscored, 0);
  // 词典降级结果（confidence 0.55 < 0.6）不进严格负面口径
  const dict = sentiment.dictScore("避雷帖：全是坑");
  assert.equal(dict.sentiment, "neg");
  assert.ok(dict.confidence < 0.6, "词典 confidence 0.55，故意低于严格口径门槛");
});

test("real 模式 LLM 批量打分：批量 ≤2 分批调用；反讽判负；每日预算超限自动降级词典", async () => {
  sentiment._resetSentiment();
  process.env.PROMO_PROVIDER_MODE = "real";
  process.env.PROMO_ONEAPI_BASE_URL = "http://mock-oneapi.local";
  process.env.PROMO_ONEAPI_API_KEY = "sk-test";
  let calls = 0;
  const seenPayloads = [];
  const origFetch = globalThis.fetch;
  const fetchMock = mock.method(globalThis, "fetch", async (input, init) => {
    const url = String(input);
    if (!url.includes("/chat/completions")) return origFetch(input, init);
    calls++;
    const body = JSON.parse(init.body);
    seenPayloads.push(body);
    const items = JSON.parse(body.messages[1].content);
    // 每批全部返回合法结果（i 对应批内序号）
    const results = items.map((it) => ({
      i: it.i,
      sentiment: it.text.includes("大开眼界") ? "neg" : it.text.includes("提升") ? "pos" : "neu",
      score: it.text.includes("大开眼界") ? -0.92 : 0.85,
      confidence: 0.93,
    }));
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ results }) } }], usage: { total_tokens: 321 } }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  });
  try {
    const mentions = [
      { id: "r1", text: "又双叒翻车了，大开眼界", platform: "douyin", crawledAt: new Date().toISOString() },
      { id: "r2", text: "效率提升明显", platform: "douyin", crawledAt: new Date().toISOString() },
      { id: "r3", text: "普通讨论帖", platform: "douyin", crawledAt: new Date().toISOString() },
    ];
    const stats = await sentiment.scorePendingMentions(mentions);
    // 预算 2：批 1（r1+r2）走 LLM（usage 0→2）；批 2（r3）usage 2 ≥ 2 → 降级词典
    assert.equal(stats.mode, "llm");
    assert.equal(stats.llmScored, 2);
    assert.equal(stats.dictScored, 1);
    assert.equal(stats.downgraded, true, "达到每日预算 PROMO_NLP_DAILY_CAP 后降级");
    assert.equal(calls, 1, "批量 ≤2：批 1 一次 LLM 调用，批 2 被预算拦截不再调用");
    assert.equal(seenPayloads[0].messages[1].content.length <= 2 * 60, true, "批量请求应打包多条");
    const s1 = sentiment.getScore("r1");
    assert.equal(s1.sentiment, "neg", "LLM 应把反讽判负面");
    assert.equal(s1.source, "llm");
    assert.ok(s1.score <= -0.9 && s1.confidence >= 0.6);
    assert.ok(stats.tokens >= 321);
    const s3 = sentiment.getScore("r3");
    assert.equal(s3.source, "dict", "预算超限批次走词典降级");
    assert.ok(s3.confidence < 0.6);
  } finally {
    fetchMock.mock.restore();
    delete process.env.PROMO_PROVIDER_MODE;
    delete process.env.PROMO_ONEAPI_BASE_URL;
    delete process.env.PROMO_ONEAPI_API_KEY;
  }
});

test("LLM 单批失败 → 该批整体词典兜底，不阻断不抛错", async () => {
  sentiment._resetSentiment();
  process.env.PROMO_PROVIDER_MODE = "real";
  process.env.PROMO_ONEAPI_BASE_URL = "http://mock-oneapi.local";
  process.env.PROMO_ONEAPI_API_KEY = "sk-test";
  process.env.PROMO_NLP_DAILY_CAP = "0"; // 关闭预算
  const origFetch = globalThis.fetch;
  const fetchMock = mock.method(globalThis, "fetch", async (input, init) => {
    if (!String(input).includes("/chat/completions")) return origFetch(input, init);
    return new Response("upstream boom", { status: 500 });
  });
  try {
    const mentions = [{ id: "f1", text: "随便一条", platform: "xhs", crawledAt: new Date().toISOString() }];
    const stats = await sentiment.scorePendingMentions(mentions);
    assert.equal(stats.llmScored, 0);
    assert.equal(stats.dictScored, 1);
    assert.ok(stats.errors.length >= 1, "失败原因应被记录");
    assert.equal(sentiment.getScore("f1").source, "dict");
  } finally {
    fetchMock.mock.restore();
    delete process.env.PROMO_PROVIDER_MODE;
    delete process.env.PROMO_ONEAPI_BASE_URL;
    delete process.env.PROMO_ONEAPI_API_KEY;
    delete process.env.PROMO_NLP_DAILY_CAP;
  }
});

test("server e2e：采集 → 打分 → 摘要 → mentions 带情绪字段", async () => {
  sentiment._resetSentiment();
  const { _resetMentions, addMentions } = await import("../src/radar/mentions.js");
  _resetMentions();
  addMentions([
    { platform: "douyin", text: "翻车避雷：千万别踩坑", keywordSet: "e2e", crawledAt: new Date().toISOString() },
    { platform: "xhs", text: "效率提升明显，推荐大家用", keywordSet: "e2e", crawledAt: new Date().toISOString() },
  ]);
  const srv = await listen(app);
  const base = `http://127.0.0.1:${srv.address().port}`;
  try {
    const score = await (await fetch(`${base}/api/radar/score`, { method: "POST" })).json();
    assert.equal(score.mode, "demo");
    assert.equal(score.demoScored, 2);
    assert.ok(score.nlp?.model, "nlp 配置随响应下发");
    const sum = await (await fetch(`${base}/api/radar/sentiment?windowHours=24`)).json();
    assert.equal(sum.scored, 2);
    assert.equal(sum.neg, 1);
    assert.equal(sum.negativeVolume, 1);
    assert.ok(sum.index >= 0 && sum.index <= 100);
    const ms = await (await fetch(`${base}/api/radar/mentions?limit=10`)).json();
    const withSent = ms.items.filter((m) => m.sentiment);
    assert.equal(withSent.length, 2, "mentions 列表应合并情绪字段");
    assert.ok(withSent.every((m) => ["pos", "neu", "neg"].includes(m.sentiment) && typeof m.sentimentScore === "number"));
  } finally {
    srv.close();
  }
});
