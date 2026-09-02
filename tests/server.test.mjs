import { test } from "node:test";
import assert from "node:assert/strict";

process.env.STEP_DELAY_MS = "10"; // 加速测试，避免每步 400ms 真实停顿

const BASE = (port) => `http://127.0.0.1:${port}`;
const waitStatus = async (port, runId, statuses, timeoutMs = 15000) => {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const r = await fetch(`${BASE(port)}/api/runs/${runId}`);
    if (r.ok) {
      const run = await r.json();
      if (statuses.includes(run.status)) return run;
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`run ${runId} 未在 ${timeoutMs}ms 内进入 ${statuses}`);
};

const baseBrief = {
  brandName: "铭星科技",
  productName: "星链 Pro",
  coreSellingPoint: "一句话生成专业宣传片",
  tones: ["科技感"],
  durationSec: 30,
  language: "zh-CN",
  voiceTone: "男声",
};

test("非法 Brief 返回 400", async () => {
  const { app } = await import("../src/server.js");
  const server = app.listen(0);
  const port = server.address().port;
  try {
    const r = await fetch(`${BASE(port)}/api/generate`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({}),
    });
    assert.equal(r.status, 400);
  } finally {
    server.close();
  }
});

test("HITL 关闭：端到端产出分镜画廊 + SRT", async () => {
  const { app } = await import("../src/server.js");
  const server = app.listen(0);
  const port = server.address().port;
  try {
    const r = await fetch(`${BASE(port)}/api/generate`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...baseBrief, hitlEnabled: false }),
    });
    assert.equal(r.status, 200);
    const { runId } = await r.json();
    const run = await waitStatus(port, runId, ["success", "failed"]);
    assert.equal(run.status, "success");
    assert.ok(Array.isArray(run.storyboardGallery) && run.storyboardGallery.length >= 3, "应产出分镜画廊");
    assert.ok(run.srt && run.srt.includes("-->"), "应产出 SRT");
    assert.equal(run.brief.language, "zh-CN");
  } finally {
    server.close();
  }
});

test("HITL 开启：脚本门 suspend → approve → success", async () => {
  const { app } = await import("../src/server.js");
  const server = app.listen(0);
  const port = server.address().port;
  try {
    const r = await fetch(`${BASE(port)}/api/generate`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...baseBrief, hitlEnabled: true }),
    });
    const { runId } = await r.json();
    const suspended = await waitStatus(port, runId, ["suspended"]);
    assert.equal(suspended.status, "suspended");

    const approve = await fetch(`${BASE(port)}/api/generate/${runId}/approve`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ decision: "approve" }),
    });
    assert.equal(approve.status, 200);

    const done = await waitStatus(port, runId, ["success", "failed"]);
    assert.equal(done.status, "success");
    assert.ok(Array.isArray(done.storyboardGallery) && done.storyboardGallery.length >= 3);
  } finally {
    server.close();
  }
});
