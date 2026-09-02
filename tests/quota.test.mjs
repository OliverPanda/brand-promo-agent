// M3-C 账户级累计配额单测（对应 PRD FR-10「成本配额」/ §13 M3）。
// setup.mjs 已设置 PROMO_PERSIST=0 → quota 仅内存态，测试互不污染（账户名区分即可）。
import { test } from "node:test";
import assert from "node:assert/strict";

const quota = await import("../src/quota.js");
const { getQuotaCap, getUsage, checkQuota, addUsage, QuotaExceededError } = quota;

const round = (n) => Math.round((n + Number.EPSILON) * 10000) / 10000;

test("getQuotaCap 读 PROMO_QUOTA_CAP，默认 200", () => {
  const prev = process.env.PROMO_QUOTA_CAP;
  delete process.env.PROMO_QUOTA_CAP;
  try {
    assert.equal(getQuotaCap(), 200);
  } finally {
    if (prev === undefined) delete process.env.PROMO_QUOTA_CAP;
    else process.env.PROMO_QUOTA_CAP = prev;
  }
});

test("checkQuota 未超限 ok=true 且返回 used/cap/remaining", () => {
  const acc = "quota-acct-a";
  const g = checkQuota(acc, 10);
  assert.equal(g.ok, true);
  assert.equal(g.cap, 200);
  assert.equal(g.remaining, round(200 - g.used - 10));
});

test("addUsage + checkQuota 累计正确", () => {
  const acc = "quota-acct-b";
  const before = getUsage(acc);
  addUsage(acc, 5);
  const g = checkQuota(acc, 3);
  assert.equal(g.used, round(before + 5));
  assert.equal(g.total, round(before + 5 + 3));
  assert.equal(g.ok, g.total <= g.cap);
});

test("checkQuota 超限 ok=false（total > cap）", () => {
  const acc = "quota-acct-c";
  const prev = process.env.PROMO_QUOTA_CAP;
  process.env.PROMO_QUOTA_CAP = "1";
  try {
    addUsage(acc, 0.5);
    const g = checkQuota(acc, 0.6);
    assert.equal(g.ok, false);
    assert.ok(g.total > g.cap);
  } finally {
    process.env.PROMO_QUOTA_CAP = prev;
  }
});

test("QuotaExceededError 携带错误码且不可重试", () => {
  const e = new QuotaExceededError("配额超限");
  assert.equal(e.name, "QuotaExceededError");
  assert.equal(e.code, "QUOTA_EXCEEDED");
  assert.equal(e.retryable, false);
  assert.ok(e instanceof Error);
});
