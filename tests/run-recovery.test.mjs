import { test } from "node:test";
import assert from "node:assert/strict";
import { app } from "../src/server.js";
import { createRun, updateRun, setStep, newRunId, registerResumer, getResumer } from "../src/store.js";
import { bus } from "../src/mastra/eventBus.js";
import { mastra } from "../src/mastra/workflow.js";

const brief = { brandName: "恢复测试", productName: "产品", coreSellingPoint: "可靠生成", hitlEnabled: false, finalGateEnabled: true };

async function withServer(fn) {
  const server = app.listen(0);
  try { await fn(`http://127.0.0.1:${server.address().port}`); }
  finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
}

for (const status of ["running", "suspended", "awaiting_delivery", "success", "failed"]) {
  test(`SSE 迟到订阅恢复 ${status}，公开视频地址且清理订阅`, async () => {
    const id = newRunId();
    createRun(id, brief);
    updateRun(id, { status, error: "测试失败", videoUrl: "file://C:/test/out.mp4", steps: { composite: { status: "done" } } });
    const resumer = () => {};
    registerResumer(id, resumer);
    const before = bus.listenerCount("progress");
    await withServer(async base => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 1500);
      let body = "";
      try {
        const response = await fetch(`${base}/api/generate/${id}/stream`, { signal: controller.signal });
        for await (const chunk of response.body) {
          body += Buffer.from(chunk).toString();
          if (!["success", "failed"].includes(status) && body.includes("event: snapshot") && (status !== "awaiting_delivery" || body.includes("event: final-review"))) break;
        }
      } catch (error) { if (error.name !== "AbortError") throw error; }
      finally { clearTimeout(timer); controller.abort(); }
      assert.match(body, /event: snapshot/);
      const snapshot = JSON.parse(body.split("event: snapshot\ndata: ")[1].split("\n\n")[0]);
      assert.equal(snapshot.run.status, status);
      assert.equal(snapshot.run.videoUrl, `/api/video/${id}`);
      assert.equal(snapshot.run.steps.composite.status, "done");
      if (status === "awaiting_delivery") assert.match(body, /event: final-review/);
      if (status === "success") assert.match(body, /event: run-done/);
      if (status === "failed") assert.match(body, /event: run-failed/);
    });
    for (let i = 0; i < 50 && bus.listenerCount("progress") !== before; i++) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(bus.listenerCount("progress"), before);
    if (["running", "suspended", "awaiting_delivery"].includes(status)) assert.equal(getResumer(id), resumer);
  });
}

test("不存在的 SSE 任务返回 404", async () => withServer(async base => {
  const response = await fetch(`${base}/api/generate/missing/stream`);
  assert.equal(response.status, 404);
  await response.body.cancel();
}));

for (const phase of ["promoScript", "promoVideo"]) {
  for (const rejects of [false, true]) {
    test(`${phase} ${rejects ? "reject" : "resolve failed"} 不得交付，发布一次失败终态`, async t => {
      const workflow = mastra.getWorkflow(phase);
      t.mock.method(workflow, "createRun", async () => ({ start: async () => {
        if (rejects) throw new Error("阶段失败");
        return { status: "failed", error: new Error("阶段失败") };
      } }));
      await withServer(async base => {
        const failures = [];
        const onFailed = event => failures.push(event);
        bus.on("run-failed", onFailed);
        try {
          const response = await fetch(`${base}/api/generate`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(brief) });
          assert.equal(response.status, 200);
          const { runId } = await response.json();
          let run;
          for (let i = 0; i < 100; i++) {
            run = await (await fetch(`${base}/api/runs/${runId}`)).json();
            if (run.status !== "running") break;
            await new Promise(resolve => setTimeout(resolve, 20));
          }
          assert.equal(run.status, "failed");
          assert.match(run.error, /阶段失败/);
          assert.equal(failures.filter(e => e.runId === runId).length, 1);
        } finally { bus.off("run-failed", onFailed); }
      });
    });
  }
}

test("引擎 resolve success 但核心步骤失败时，不得覆盖成片验收状态", async t => {
  t.mock.method(mastra.getWorkflow("promoVideo"), "createRun", async () => ({ start: async ({ inputData }) => {
    setStep(inputData.runId, "storyboard", { status: "failed", error: "分镜超时" });
    return { status: "success" };
  } }));
  await withServer(async base => {
    const { runId } = await (await fetch(`${base}/api/generate`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(brief) })).json();
    let run;
    for (let i = 0; i < 100; i++) {
      run = await (await fetch(`${base}/api/runs/${runId}`)).json();
      if (run.status !== "running") break;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.equal(run.status, "failed");
    assert.match(run.error, /分镜超时/);
  });
});
