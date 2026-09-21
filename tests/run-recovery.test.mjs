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

// 说明：REAL 模式的交付契约是「已校验的持久化成片」，工作流回报 success 不足以放行；
// 这里用 mock 让两段工作流都成功但不产出 artifactManifest，验证服务端交付门会拦下并置 failed。
test("REAL 模式缺少已校验产物时不得进入成片门", async t => {
  const previousMode = process.env.PROMO_PROVIDER_MODE;
  const previousDeps = app.locals.generationPreflightDependencies;
  process.env.PROMO_PROVIDER_MODE = "real";
  app.locals.generationPreflightDependencies = {
    verifyMediaToolchain: async () => {},
    artifactPaths: () => ({ outputRoot: process.cwd(), workspace: process.cwd() }),
    verifyWritable: async () => {},
    providerBase: () => "http://127.0.0.1:1",
    providerKey: () => "test-key",
    fetchRemoteModels: async () => ({
      byType: { video: ["minimax-h3"], audio: ["speech-02-hd"] },
      raw: [{ id: "minimax-h3", type: "video" }, { id: "speech-02-hd", type: "tts" }],
    }),
    musicPath: () => "/audio/music",
    musicModel: () => "mureka-v1",
    ttsModel: () => "speech-02-hd",
    videoModel: () => "",
  };
  t.mock.method(mastra.getWorkflow("promoScript"), "createRun", async () => ({ start: async () => ({ status: "success" }) }));
  t.mock.method(mastra.getWorkflow("promoVideo"), "createRun", async () => ({ start: async () => ({ status: "success" }) }));
  const finalReviews = [];
  const onReview = event => finalReviews.push(event);
  bus.on("final-review", onReview);
  try {
    await withServer(async base => {
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
      assert.match(run.error, /已校验产物清单/);
      assert.equal(finalReviews.filter(event => event.runId === runId).length, 0);
    });
  } finally {
    bus.off("final-review", onReview);
    app.locals.generationPreflightDependencies = previousDeps;
    if (previousMode === undefined) delete process.env.PROMO_PROVIDER_MODE;
    else process.env.PROMO_PROVIDER_MODE = previousMode;
  }
});
