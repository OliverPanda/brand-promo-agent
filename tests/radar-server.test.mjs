// 舆情雷达 server 端点 e2e（DEMO 模式）：订阅 → 采集 → 热词 → 状态。
import { test, mock } from "node:test";
import assert from "node:assert/strict";

process.env.PROMO_PERSIST = "0";
process.env.PROMO_PROVIDER_MODE = "demo"; // 显式 DEMO

const { app } = await import("../src/server.js");

function listen(app) {
  return new Promise((resolve) => {
    const srv = app.listen(0, () => resolve(srv));
  });
}

const srv = await listen(app);
const base = `http://127.0.0.1:${srv.address().port}`;

test("GET /api/radar/status：DEMO 模式 + 平台可用性", async () => {
  const r = await fetch(`${base}/api/radar/status`);
  const j = await r.json();
  assert.equal(j.mode, "demo");
  assert.ok(Array.isArray(j.platforms) && j.platforms.length >= 4);
  assert.ok(j.platforms.every((p) => p.available === true), "DEMO 模式全平台可用");
});

test("订阅 CRUD e2e：POST → GET → DELETE；预置 DELETE 409", async () => {
  const post = await fetch(`${base}/api/radar/subscriptions`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "e2e 订阅", keywords: ["端到端测试"], platforms: ["douyin"] }),
  });
  assert.equal(post.status, 201);
  const created = await post.json();
  const list = await (await fetch(`${base}/api/radar/subscriptions`)).json();
  assert.ok(list.some((s) => s.id === created.id));
  const del = await fetch(`${base}/api/radar/subscriptions/${created.id}`, { method: "DELETE" });
  assert.equal(del.status, 200);
  const delPreset = await fetch(`${base}/api/radar/subscriptions/preset-mingstar-radar`, { method: "DELETE" });
  assert.equal(delPreset.status, 409);
  const bad = await fetch(`${base}/api/radar/subscriptions`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "坏订阅", keywords: [], platforms: ["douyin"] }),
  });
  assert.equal(bad.status, 400);
});

test("采集 → 热词 e2e：DEMO 种子入库存，二次采集全去重，热词榜可渲染数据", async () => {
  const c1 = await (await fetch(`${base}/api/radar/collect`, { method: "POST" })).json();
  assert.equal(c1.mode, "demo");
  assert.ok(c1.added > 0, "首轮应有新增");
  assert.equal(c1.requests, 0, "DEMO 零计费请求");
  const c2 = await (await fetch(`${base}/api/radar/collect`, { method: "POST" })).json();
  assert.equal(c2.added, 0, "同轮内容指纹稳定 → 二轮全去重");
  assert.equal(c2.duplicates, c1.added);

  const hw = await (await fetch(`${base}/api/radar/hotwords?range=day`)).json();
  assert.ok(hw.keywords?.length > 0);
  assert.ok(hw.keywords.every((k) => typeof k.score === "number" && k.count >= 1));

  const mentions = await (await fetch(`${base}/api/radar/mentions?limit=5`)).json();
  assert.ok(mentions.total >= c1.added);
  assert.ok(mentions.items.length <= 5);
  assert.ok(mentions.items.every((m) => !m.author || m.author.startsWith("a:"), "作者仅以脱敏哈希输出"));
});

test("DEMO 种子内容零外呼（fetch 全局拦截断言：采集轮不打任何外网请求）", async () => {
  const origFetch = globalThis.fetch;
  const fetchMock = mock.method(globalThis, "fetch", async (input, init) => {
    const url = String(input);
    if (url.startsWith(base)) return origFetch(input, init); // 本机自调放行
    throw new Error(`DEMO 模式不应外呼：${url}`);
  });
  try {
    const r = await origFetch(`${base}/api/radar/collect`, { method: "POST" });
    const j = await r.json();
    assert.equal(j.mode, "demo");
    assert.ok(j.added >= 0);
  } finally {
    fetchMock.mock.restore();
  }
});

test("close", () => srv.close());
