import { test } from "node:test";
import assert from "node:assert/strict";
import { bus, emitProgress, emitRunDone, emitRunFailed } from "../src/mastra/eventBus.js";

test("emitProgress 在 bus 上发出 progress 事件", () => {
  return new Promise((resolve) => {
    const on = (e) => {
      bus.off("progress", on);
      assert.equal(e.runId, "r1");
      assert.equal(e.step, "writeScript");
      assert.equal(e.status, "step-start");
      resolve();
    };
    bus.on("progress", on);
    emitProgress("r1", "writeScript", "step-start");
  });
});

test("emitRunDone / emitRunFailed 终态事件", () => {
  return new Promise((resolve) => {
    const onDone = (e) => {
      bus.off("run-done", onDone);
      bus.off("run-failed", onFailed);
      assert.equal(e.runId, "r2");
      assert.ok(e.run);
      resolve();
    };
    const onFailed = () => { bus.off("run-done", onDone); bus.off("run-failed", onFailed); };
    bus.on("run-done", onDone);
    bus.on("run-failed", onFailed);
    emitRunDone("r2", { runId: "r2", status: "success" });
  });
});
