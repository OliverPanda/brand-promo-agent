// 选题会商（M3 收窄版）测试：人设库 / DEMO 确定性生成 / 打分公式与排序 / 禁用词过滤 / 下发去重 / LLM 路径 / server e2e 下发。
import { test, mock } from "node:test";
import assert from "node:assert/strict";

process.env.PROMO_PERSIST = "0";
delete process.env.PROMO_PROVIDER_MODE; // 默认 DEMO
process.env.STEP_DELAY_MS = "0"; // e2e 下发走 DEMO 工作流，提速

const persona = await import("../src/radar/persona.js");
const topics = await import("../src/radar/topics.js");
const sentiment = await import("../src/radar/sentiment.js");
const { app } = await import("../src/server.js");
const { addMentions, allMentions, _resetMentions } = await import("../src/radar/mentions.js");
const { demoMentions } = await import("../src/radar/tikhub.js");

const SUMMARY = { negativeVolume: 4, negRatio: 5.3 }; // 测试用情绪摘要（defense 分支依赖 negativeVolume>0）

test("人设库：预置铭星链默认值；字段校验（坏主色/坏数组 400 语义）；命中检查", () => {
  persona._resetPersona();
  const p = persona.getPersona();
  assert.equal(p.brandName, "铭星链");
  assert.equal(p.isPreset, true);
  assert.ok(Array.isArray(p.bannedWords) && p.bannedWords.length > 0);
  assert.throws(() => persona.savePersona({ logoColor: "red" }), /主色/);
  assert.throws(() => persona.savePersona({ tones: "不是数组" }), /字符串数组/);
  assert.throws(() => persona.savePersona({ brandName: "" }), /必填/);
  persona.savePersona({ bannedWords: ["借势"], tones: ["国潮"] });
  assert.deepEqual(persona.getPersona().bannedWords, ["借势"]);
  assert.deepEqual(persona.personaViolations("这波借势操作"), ["借势"]);
  persona._resetPersona();
});

test("scoreTopic：total = 0.45热 + 0.35契 + 0.20(100−险)，ctr 槽位预留 0%", () => {
  const s = topics.scoreTopic({ heat: 80, fit: 60, risk: 40 });
  assert.equal(s.total, 69); // 36 + 21 + 12
  assert.equal(s.ctr, null);
  // 越界钳制：heat 150→100、fit -5→0、risk 非法→0 → 45 + 0 + 20 = 65
  assert.equal(topics.scoreTopic({ heat: 150, fit: -5, risk: "x" }).total, 65);
});

test("DEMO 确定性选题：10 个、依据强制、排序按总分降序", async () => {
  persona._resetPersona();
  topics._resetTopics();
  _resetMentions();
  addMentions([...demoMentions("douyin", "测试词"), ...demoMentions("xhs", "测试词")].map((m) => ({ ...m, platform: m.platform || "douyin", keywordSet: "测试订阅" })));
  const r = await topics.generateTopics({ mentions: allMentions(), sentimentSummary: SUMMARY });
  assert.equal(r.source, "demo");
  assert.equal(r.topics.length, 10);
  assert.ok(r.topics.every((t) => t.evidence.length >= 1), "强制依据：每题 ≥1 条引用");
  assert.ok(r.topics.every((t) => t.scores.total === Math.round(0.45 * t.scores.heat + 0.35 * t.scores.fit + 0.2 * (100 - t.scores.risk))));
  for (let i = 1; i < r.topics.length; i++) {
    assert.ok(r.topics[i - 1].scores.total >= r.topics[i].scores.total, "按总分降序");
  }
  assert.deepEqual(r.topics.map((t) => t.rank), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  // 二次生成内容一致（确定性）
  const r2 = await topics.generateTopics({ mentions: allMentions(), sentimentSummary: SUMMARY });
  assert.deepEqual(r2.topics.map((t) => t.title), r.topics.map((t) => t.title));
});

test("禁用词过滤 + 下发去重（FR-7.3 简化版）", async () => {
  persona._resetPersona();
  topics._resetTopics();
  persona.savePersona({ bannedWords: ["借势"] }); // DEMO 借势选题标题均含「借势」→ 全部过滤
  const r1 = await topics.generateTopics({ mentions: allMentions(), sentimentSummary: SUMMARY });
  assert.equal(r1.topics.length, 6, "TYPE_CYCLES 借势 ×4（尾 2 席被 defense 分支占用），10 - 4 = 6");
  assert.ok(r1.errors.some((e) => e.includes("禁用词")));
  // 下发第一名后再生成：该标题 14 天内不再出现
  const first = r1.topics[0];
  topics.recordDispatch(first.id, "run-test-1");
  const r2 = await topics.generateTopics({ mentions: allMentions(), sentimentSummary: SUMMARY });
  assert.ok(!r2.topics.some((t) => t.title === first.title), "已下发标题去重");
  assert.equal(topics.dispatchedHistory().length, 1);
  assert.throws(() => topics.recordDispatch("nope", "run-x"), /不存在或已过期/);
  persona._resetPersona();
  topics._resetTopics();
});

test("real 模式 LLM 选题：依据词越界丢弃、无依据淘汰、DEMO 补齐到 10；坏分值被钳制", async () => {
  persona._resetPersona();
  topics._resetTopics();
  process.env.PROMO_PROVIDER_MODE = "real";
  process.env.PROMO_ONEAPI_BASE_URL = "http://mock-oneapi.local";
  process.env.PROMO_ONEAPI_API_KEY = "sk-test";
  const origFetch = globalThis.fetch;
  const fetchMock = mock.method(globalThis, "fetch", async (input, init) => {
    const url = String(input);
    if (!url.includes("/chat/completions")) return origFetch(input, init);
    const body = JSON.parse(init.body);
    assert.ok(body.messages[0].content.includes("选题策划"), "system 注入选题约束");
    const llmTopics = [
      { title: "LLM 选题 A（合规）", keyMessages: ["要点1"], format: "图文", channel: "小红书", type: "trend", evidenceWords: ["编造词"], heat: 150, fit: 70, risk: 10 },
      { title: "LLM 选题 B（合规）", keyMessages: [], format: "宣传片", channel: "抖音", type: "offense", evidenceWords: ["无关词", "另一编造"], heat: 90, fit: 80, risk: 20 },
      { title: "", type: "trend", evidenceWords: ["x"] }, // 无标题 → 淘汰
    ];
    // evidenceWords 全部为编造（不在热词表）→ 全淘汰，触发 DEMO 补齐/回落
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ topics: llmTopics }) } }], usage: { total_tokens: 999 } }), { status: 200, headers: { "Content-Type": "application/json" } });
  });
  try {
    const r = await topics.generateTopics({ mentions: allMentions(), sentimentSummary: SUMMARY });
    // 3 个 LLM 选题全部因依据越界被淘汰（0 < 5）→ 整体回落 DEMO
    assert.equal(r.source, "demo");
    assert.equal(r.topics.length, 10);
    assert.ok(r.errors.some((e) => e.includes("回落 DEMO")));
  } finally {
    fetchMock.mock.restore();
    delete process.env.PROMO_PROVIDER_MODE;
    delete process.env.PROMO_ONEAPI_BASE_URL;
    delete process.env.PROMO_ONEAPI_API_KEY;
  }
});

test("real 模式 LLM 合规产出：source=llm，DEMO 补齐缺口，钳制生效", async () => {
  persona._resetPersona();
  topics._resetTopics();
  process.env.PROMO_PROVIDER_MODE = "real";
  process.env.PROMO_ONEAPI_BASE_URL = "http://mock-oneapi.local";
  process.env.PROMO_ONEAPI_API_KEY = "sk-test";
  const origFetch = globalThis.fetch;
  const fetchMock = mock.method(globalThis, "fetch", async (input, init) => {
    if (!String(input).includes("/chat/completions")) return origFetch(input, init);
    // 从请求里取真实热词表，保证 evidenceWords 命中
    const userPayload = JSON.parse(JSON.parse(init.body).messages[1].content);
    const w = (userPayload.hotwords || [])[0]?.word || "热词";
    const mk = (n, extra = {}) => ({ title: `LLM 合规选题${n}`, keyMessages: ["k"], format: "图文", channel: "公众号", type: "trend", evidenceWords: [w], heat: 70, fit: 75, risk: 25, ...extra });
    const llmTopics = [
      mk("一", { heat: 150, type: "defense", risk: 45, format: "海报", channel: "微博" }),
      mk("二"),
      mk("三", { evidenceWords: [] }), // 无依据 → 淘汰
      mk("四"),
      mk("五"),
      mk("六"),
    ];
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ topics: llmTopics }) } }], usage: { total_tokens: 1234 } }), { status: 200, headers: { "Content-Type": "application/json" } });
  });
  try {
    const r = await topics.generateTopics({ mentions: allMentions(), sentimentSummary: SUMMARY });
    assert.equal(r.source, "llm");
    const llmOnes = r.topics.filter((t) => t.title.startsWith("LLM 合规"));
    assert.equal(llmOnes.length, 5, "5 个合规入选；无依据的第三条被淘汰");
    assert.equal(r.topics.length, 10, "DEMO 模板补齐到 10（≥5 合规 → 不整体回落）");
    const a = llmOnes.find((t) => t.title === "LLM 合规选题一");
    assert.equal(a.scores.heat, 100, "heat 150 钳制到 100");
    assert.ok(a.evidence.length >= 1 && a.model, "依据来自真实热词 + 模型记录");
  } finally {
    fetchMock.mock.restore();
    delete process.env.PROMO_PROVIDER_MODE;
    delete process.env.PROMO_ONEAPI_BASE_URL;
    delete process.env.PROMO_ONEAPI_API_KEY;
  }
});

test("server e2e：采集→打分→生成→一键下发→run 进入流水线（脚本门挂起等待审批）", async () => {
  persona._resetPersona();
  topics._resetTopics();
  sentiment._resetSentiment();
  _resetMentions();
  const srv = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const base = `http://127.0.0.1:${srv.address().port}`;
  try {
    await fetch(`${base}/api/radar/collect`, { method: "POST" });
    await fetch(`${base}/api/radar/score`, { method: "POST" });
    const gen = await (await fetch(`${base}/api/radar/topics/generate`, { method: "POST" })).json();
    assert.equal(gen.topics.length, 10);
    // 人设 PUT 校验与保存
    const bad = await fetch(`${base}/api/radar/persona`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ logoColor: "nope" }) });
    assert.equal(bad.status, 400);
    const put = await fetch(`${base}/api/radar/persona`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ tones: ["科技感"] }) });
    assert.equal(put.status, 200);
    // 今日榜
    const list = await (await fetch(`${base}/api/radar/topics`)).json();
    assert.equal(list.topics.length, 10);
    assert.ok(list.config?.weights?.heat === 0.45);
    // 一键下发第一名：hitl 开 → run 应挂起在脚本门
    const d = await fetch(`${base}/api/radar/topics/${list.topics[0].id}/dispatch`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ hitlEnabled: true }) });
    assert.equal(d.status, 200);
    const dj = await d.json();
    assert.ok(dj.runId);
    assert.equal(dj.brief.brandName, "铭星链", "Brief 由人设预填");
    assert.ok(dj.brief.keyMessages.includes(list.topics[0].title), "选题标题注入 keyMessages");
    // 轮询 run 状态直到进入稳定态（suspended = 脚本门挂起）
    let status = "";
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 250));
      const run = await (await fetch(`${base}/api/runs/${dj.runId}`)).json();
      status = run.status;
      if (["suspended", "success", "failed"].includes(status)) break;
    }
    assert.equal(status, "suspended", "hitl 开启时下发应停在脚本确认门");
    // 二次下发同题 → 仍可（同题允许重复下发），但历史留痕
    const again = await fetch(`${base}/api/radar/topics/${list.topics[0].id}/dispatch`, { method: "POST" });
    assert.equal(again.status, 200);
    const hist = (await (await fetch(`${base}/api/radar/topics`)).json()).dispatched;
    assert.equal(hist.filter((x) => x.runId === dj.runId).length, 1, "下发历史留痕");
    // 不存在的选题 404
    const nf = await fetch(`${base}/api/radar/topics/nope/dispatch`, { method: "POST" });
    assert.equal(nf.status, 404);
  } finally {
    srv.close();
  }
});
