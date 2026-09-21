/**
 * @file 前端断线恢复与失败态回归用例。
 * @description 复用共享 VM 夹具，验证 SSE 快照恢复、旧事件隔离、失败收口与审批竞态。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { harness } from "./helpers/frontend-harness.mjs";

test("SSE 快照恢复步骤与成片门，真实八步骤全部中文", () => {
  const h = harness(); h.run('openStream("r1")');
  const steps = Object.fromEntries(["ingestBrief", "writeScript", "prepareVideo", "storyboard", "generateScenes", "voiceover", "music", "composite"].map(id => [id, { status: "done" }]));
  h.sources[0].send("snapshot", { run: { runId: "r1", status: "awaiting_delivery", steps, storyboard: [] } });
  assert.equal(h.nodes.get("steps").children.length, 8);
  assert.match(h.nodes.get("step-voiceover").querySelector(".name").textContent, /配音/);
  assert.equal(h.nodes.get("progBar").style.width, "100%");
  assert.equal(h.rendered[0][0], "final");
});

test("旧 SSE 事件不能结束新任务，网络错误保留原生重连", () => {
  const h = harness(); h.run('openStream("r1")');
  h.run('currentRunId = "r2"; openStream("r2")');
  h.sources[0].send("run-failed", { error: "旧错误" });
  assert.ok(!h.sources[1].closed);
  assert.equal(h.notices.length, 0);
  h.sources[1].onerror();
  assert.ok(!h.sources[1].closed);
  assert.match(h.nodes.get("progText").textContent, /重连/);
});

test("失败终态显示错误并关闭审核门，交付不伪造全部完成", () => {
  const h = harness(); h.run('openStream("r1")');
  h.sources[0].send("snapshot", { run: { runId: "r1", status: "failed", error: "分镜超时", steps: { storyboard: { status: "failed", error: "分镜超时" } } } });
  assert.ok(h.sources[0].closed);
  assert.match(h.notices[0][0], /分镜超时/);
  assert.equal(h.nodes.get("progBar").style.width, "0%");
});

test("刷新恢复指定任务且新任务已选中时不覆盖", async () => {
  const h = harness();
  h.run('currentRunId = null; location.search = "?runId=saved"');
  h.context.fetch = async () => ({ ok: true, status: 200, json: async () => ({ runId: "saved", status: "running", steps: {} }) });
  await h.run("restoreRun()");
  assert.equal(h.sources.at(-1).url, "/api/generate/saved/stream");
  h.run('currentRunId = "new"');
  await h.run("restoreRun()");
  assert.equal(h.run("currentRunId"), "new");
});

test("审批响应晚于 SSE 交付时不把已完成步骤写成交付中", async () => {
  const h = harness(); h.run('openStream("r1")');
  const run = { runId: "r1", status: "success", steps: { composite: { status: "done" } } };
  h.context.fetch = async (url, options) => {
    if (options?.method === "POST") h.sources[0].send("run-done", { run });
    return { ok: true, status: 200, json: async () => run };
  };
  await h.run("approveFinal(true)");
  assert.equal(h.nodes.get("step-composite")?.querySelector(".meta").textContent || "", "");
});
