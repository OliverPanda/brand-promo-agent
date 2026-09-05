// M2 成本/预算单测（对应 PRD FR-10 / §15）。纯逻辑，无网络。
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  costFor,
  round4,
  sumCost,
  checkBudget,
  getBudgetCap,
  BudgetExceededError,
  formatCostSummary,
  VIDEO_PER_CALL_CNY,
  videoCostPerScene,
} from "../src/cost.js";

test("costFor 按步骤单价估算（tokens / images / minutes / tracks）", () => {
  assert.equal(costFor("writeScript", { tokens: 1000 }).amount, 0.004); // 1k * 0.004
  assert.equal(costFor("storyboard", { tokens: 2500 }).amount, 0.01); // 2.5k * 0.004
  assert.equal(costFor("generateScenes", { images: 5 }).amount, 1.0); // 5 * 0.2
  assert.equal(costFor("voiceover", { minutes: 0.5 }).amount, 0.05); // 0.5 * 0.1
  assert.equal(costFor("music", { tracks: 1 }).amount, 0.5); // 1 * 0.5
  assert.equal(costFor("composite", { videos: 1 }).amount, 1.0); // 1 * 1.0
});

// 2026-09-04 视频真实单价（自中转站 new-api /api/pricing 实抓：按次 model_price × 汇率 7.3，分组 ×1）
test("costFor 视频：videoModel 命中按次表用真实单价", () => {
  assert.equal(VIDEO_PER_CALL_CNY["sora-2-pro"], 3.65); // $0.5/次 × 7.3
  assert.equal(VIDEO_PER_CALL_CNY["sora-2"], 2.19); // $0.3/次 × 7.3
  assert.equal(costFor("generateScenes", { videos: 2, videoModel: "sora-2-pro" }).amount, 7.3);
  assert.equal(costFor("generateScenes", { videos: 1, videoModel: "sora-2" }).amount, 2.19);
  // 未带 videoModel（如 composite 本地合成）仍用表内回落单价
  assert.equal(costFor("generateScenes", { videos: 3 }).amount, 3.0);
});

test("videoCostPerScene：未知/按量模型回落默认价，PROMO_VIDEO_COST_FALLBACK 可覆盖", () => {
  assert.equal(videoCostPerScene("kling-v1-6"), 1.0); // 站内按量兜底倍率 37.5，无固定每镜价 → 回落 ¥1
  assert.equal(videoCostPerScene(""), 1.0);
  assert.equal(videoCostPerScene(undefined), 1.0);
  process.env.PROMO_VIDEO_COST_FALLBACK = "2.5";
  assert.equal(videoCostPerScene("doubao-seedance-2.0"), 2.5);
  delete process.env.PROMO_VIDEO_COST_FALLBACK;
  assert.equal(videoCostPerScene("sora-2-pro"), 3.65, "环境变量不影响按次表命中");
});

test("costFor 未知步骤返回 0 且不抛", () => {
  const c = costFor("unknownStep", { tokens: 9999 });
  assert.equal(c.amount, 0);
  assert.equal(c.tokens, 9999);
});

test("costFor 缺用量字段安全回退 0", () => {
  assert.equal(costFor("generateScenes", {}).amount, 0);
  assert.equal(costFor("writeScript", undefined).amount, 0);
});

test("round4 保留 4 位小数", () => {
  assert.equal(round4(0.00048), 0.0005);
  assert.equal(round4(1.23456), 1.2346);
  assert.equal(round4(2), 2);
});

test("sumCost 累计多步", () => {
  assert.equal(sumCost([{ amount: 0.004 }, { amount: 1.0 }, { amount: 0.5 }]), 1.504);
  assert.equal(sumCost([]), 0);
  assert.equal(sumCost(undefined), 0);
});

test("checkBudget 未超限 ok=true", () => {
  const costs = [{ amount: 1.5 }, { amount: 1.0 }];
  const g = checkBudget(costs, { amount: 0 }, 20);
  assert.equal(g.ok, true);
  assert.equal(g.total, 2.5);
  assert.equal(g.cap, 20);
  assert.equal(g.over, 0);
});

test("checkBudget 超限 ok=false 且 over=超出额", () => {
  const costs = [{ amount: 19.0 }, { amount: 2.0 }]; // total 21 > cap 20
  const g = checkBudget(costs, { amount: 0 }, 20);
  assert.equal(g.ok, false);
  assert.equal(g.total, 21);
  assert.equal(g.over, 1);
});

test("checkBudget 含待加 stepCost 预判（不改调用方数据）", () => {
  const costs = [{ amount: 19.95 }];
  const cap = 20;
  const before = JSON.stringify(costs);
  const g = checkBudget(costs, { step: "music", amount: 0.5 }, cap);
  assert.equal(g.ok, false); // 19.95 + 0.5 = 20.45 > 20
  assert.equal(g.total, 20.45);
  assert.equal(JSON.stringify(costs), before, "不应修改调用方数组");
});

test("checkBudget 边界：恰好等于上限 ok=true", () => {
  const g = checkBudget([{ amount: 10 }, { amount: 10 }], { amount: 0 }, 20);
  assert.equal(g.ok, true);
  assert.equal(g.total, 20);
});

test("getBudgetCap 读环境变量 PROMO_BUDGET_CAP（运行时可改）", () => {
  const prev = process.env.PROMO_BUDGET_CAP;
  process.env.PROMO_BUDGET_CAP = "50";
  try {
    assert.equal(getBudgetCap(), 50);
  } finally {
    if (prev === undefined) delete process.env.PROMO_BUDGET_CAP;
    else process.env.PROMO_BUDGET_CAP = prev;
  }
});

test("BudgetExceededError 携带错误码且不可重试", () => {
  const e = new BudgetExceededError("预算超限");
  assert.equal(e.name, "BudgetExceededError");
  assert.equal(e.code, "BUDGET_EXCEEDED");
  assert.equal(e.retryable, false);
  assert.ok(e instanceof Error);
});

test("formatCostSummary 无成本时给出 DEMO 提示", () => {
  assert.match(formatCostSummary([]), /DEMO/);
});

test("formatCostSummary 有成本时列出明细与总额/上限", () => {
  const s = formatCostSummary([{ step: "writeScript", tokens: 1000, amount: 0.004 }, { step: "music", amount: 0.5 }]);
  assert.match(s, /本次预估总成本 ¥0\.5040/);
  assert.match(s, /writeScript/);
  assert.match(s, /music/);
});
