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
      body: JSON.stringify({ ...baseBrief, hitlEnabled: false, finalGateEnabled: false }),
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
      body: JSON.stringify({ ...baseBrief, hitlEnabled: true, finalGateEnabled: false }),
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

test("成片门（FR-9.2）：awaiting_delivery → approve → success", async () => {
  const { app } = await import("../src/server.js");
  const server = app.listen(0);
  const port = server.address().port;
  try {
    const r = await fetch(`${BASE(port)}/api/generate`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...baseBrief, hitlEnabled: false, finalGateEnabled: true }),
    });
    const { runId } = await r.json();
    const awaiting = await waitStatus(port, runId, ["awaiting_delivery"]);
    assert.equal(awaiting.status, "awaiting_delivery");
    assert.ok(awaiting.videoUrl !== undefined && awaiting.storyboardGallery.length >= 3, "成片预览应已就绪");

    const approve = await fetch(`${BASE(port)}/api/generate/${runId}/approve`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ decision: "approve" }),
    });
    assert.equal(approve.status, 200);

    const done = await waitStatus(port, runId, ["success", "failed"]);
    assert.equal(done.status, "success");
  } finally {
    server.close();
  }
});

test("成片门（FR-9.2）：reject 指定分镜 → 重新生成 → 再次 awaiting_delivery → approve", async () => {
  const { app } = await import("../src/server.js");
  const server = app.listen(0);
  const port = server.address().port;
  try {
    const r = await fetch(`${BASE(port)}/api/generate`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...baseBrief, hitlEnabled: false, finalGateEnabled: true }),
    });
    const { runId } = await r.json();
    await waitStatus(port, runId, ["awaiting_delivery"]);

    const reject = await fetch(`${BASE(port)}/api/generate/${runId}/approve`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ decision: "reject", scenes: [1] }),
    });
    assert.equal(reject.status, 200);

    const awaiting2 = await waitStatus(port, runId, ["awaiting_delivery"]);
    assert.equal(awaiting2.status, "awaiting_delivery");
    assert.equal(awaiting2.finalRejected, 1);

    await fetch(`${BASE(port)}/api/generate/${runId}/approve`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ decision: "approve" }),
    });
    const done = await waitStatus(port, runId, ["success", "failed"]);
    assert.equal(done.status, "success");
  } finally {
    server.close();
  }
});

test("GET /api/quota：返回账户累计与剩余配额", async () => {
  const { app } = await import("../src/server.js");
  const server = app.listen(0);
  const port = server.address().port;
  try {
    const r = await fetch(`${BASE(port)}/api/quota?account=acme`);
    assert.equal(r.status, 200);
    const q = await r.json();
    assert.equal(q.account, "acme");
    assert.equal(q.cap, 200);
    assert.ok(q.remaining <= q.cap);
  } finally {
    server.close();
  }
});

test("模板库端点（M4）：创建/列出/删除自定义模板", async () => {
  const { app } = await import("../src/server.js");
  const server = app.listen(0);
  const port = server.address().port;
  try {
    let r = await fetch(`${BASE(port)}/api/templates`);
    assert.equal(r.status, 200);
    assert.ok(Array.isArray(await r.json()));

    r = await fetch(`${BASE(port)}/api/templates`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "T1", defaultTone: "科技感", defaultLanguage: "en" }),
    });
    assert.equal(r.status, 201);
    const t = await r.json();
    assert.ok(t.id, "应分配 id");

    const list1 = await (await fetch(`${BASE(port)}/api/templates`)).json();
    assert.ok(list1.find((x) => x.id === t.id), "列表应包含新模板");

    r = await fetch(`${BASE(port)}/api/templates/${t.id}`, { method: "DELETE" });
    assert.equal(r.status, 200);
    const list2 = await (await fetch(`${BASE(port)}/api/templates`)).json();
    assert.ok(!list2.find((x) => x.id === t.id), "删除后不应在列表");
  } finally {
    server.close();
  }
});

test("模板库端点（M4）：非法模板名返回 400", async () => {
  const { app } = await import("../src/server.js");
  const server = app.listen(0);
  const port = server.address().port;
  try {
    const r = await fetch(`${BASE(port)}/api/templates`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({}),
    });
    assert.equal(r.status, 400);
  } finally {
    server.close();
  }
});
