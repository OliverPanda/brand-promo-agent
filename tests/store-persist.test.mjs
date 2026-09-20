// M3-A 持久化集成测试：用独立子进程验证「写盘 → 进程重启 rehydrate」。
// 每个子进程都是全新的 Node，store.js 以 PROMO_PERSIST=1 + 临时 DATA_DIR 加载，确保真实文件写穿与 hydrate。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."); // brand-promo-agent
const STORE_URL = JSON.stringify(pathToFileURL(path.join(ROOT, "src/store.js")).href);
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), "promo-persist-"));

function runModule(code, extraEnv = {}) {
  const f = path.join(DATA, "mod.mjs");
  fs.writeFileSync(f, code);
  return execFileSync(process.execPath, [f], {
    env: { ...process.env, PROMO_PERSIST: "1", PROMO_DATA_DIR: DATA, ...extraEnv },
    encoding: "utf8",
  });
}

test("store 文件持久化：写入后进程重启可 rehydrate（历史记录不丢）", () => {
  const id = "persist-run-1";
  runModule(`
    import { createRun, updateRun, setStep } from ${STORE_URL};
    const id = ${JSON.stringify(id)};
    createRun(id, { brandName: "PersistCo", productName: "P", coreSellingPoint: "s" });
    updateRun(id, { status: "success", videoUrl: "file:///x.mp4" });
    setStep(id, "writeScript", { status: "done" });
    console.log("WRITTEN");
  `);
  const runsFile = path.join(DATA, "runs.json");
  assert.ok(fs.existsSync(runsFile), "runs.json 应已写盘");
  const arr = JSON.parse(fs.readFileSync(runsFile, "utf8"));
  assert.ok(arr.find((r) => r.runId === id && r.status === "success"), "磁盘应包含该 run");

  // 重启（新进程）应 rehydrate
  const out = runModule(`
    import { getRun, listRuns } from ${STORE_URL};
    const id = ${JSON.stringify(id)};
    const r = getRun(id);
    console.log(JSON.stringify({ found: !!r, status: r && r.status, videoUrl: r && r.videoUrl, hasStep: !!(r && r.steps.writeScript), count: listRuns().length }));
  `);
  const hydrated = JSON.parse(out.trim());
  assert.equal(hydrated.found, true);
  assert.equal(hydrated.status, "success");
  assert.equal(hydrated.videoUrl, "file:///x.mp4");
  assert.equal(hydrated.hasStep, true);
  assert.ok(hydrated.count >= 1);
});

test("落盘瘦身：steps[].output 不落盘（与顶层字段重复、含大对象），hydrate 迁移旧大文件", () => {
  const id = "slim-run-1";
  const big = "x".repeat(50_000); // 模拟大 output（storyboard 重复体）
  const out = runModule(`
    import { createRun, setStep, getRun } from ${STORE_URL};
    const id = ${JSON.stringify(id)};
    createRun(id, { brandName: "SlimCo", productName: "P", coreSellingPoint: "s" });
    setStep(id, "generateScenes", { status: "done", output: { storyboard: [${JSON.stringify(big)}] } });
    // 内存里仍可读到全量（SSE 进度推送依赖）
    const inMem = getRun(id).steps.generateScenes.output.storyboard[0].length;
    console.log(JSON.stringify({ inMem }));
  `);
  assert.equal(JSON.parse(out.trim()).inMem, 50_000, "内存全量保留");
  const raw = fs.readFileSync(path.join(DATA, "runs.json"), "utf8");
  assert.ok(!raw.includes('"output"'), "磁盘不应包含 output 字段");
  assert.ok(raw.length < 10_000, `磁盘体积应远小于 output 灌入量（实际 ${raw.length}）`);
  // 重启 hydrate：剥离旧 output 后运行态其余字段完好
  const out2 = runModule(`
    import { getRun } from ${STORE_URL};
    const r = getRun(${JSON.stringify(id)});
    console.log(JSON.stringify({ hasStep: !!(r && r.steps.generateScenes), status: r && r.steps.generateScenes && r.steps.generateScenes.status }));
  `);
  assert.deepEqual(JSON.parse(out2.trim()), { hasStep: true, status: "done" });
});

test("容量封顶：PROMO_RUNS_CAP=5 时创建 7 个 run → 保留最新 5 个，最旧被淘汰", () => {
  const out = runModule(`
    import { createRun, listRuns } from ${STORE_URL};
    for (let i = 1; i <= 7; i++) createRun("cap-run-" + i, { brandName: "Cap" + i, productName: "P", coreSellingPoint: "s" });
    const ids = listRuns().map((r) => r.runId);
    console.log(JSON.stringify({ count: ids.length, hasOldest: ids.includes("cap-run-1"), hasNewest: ids.includes("cap-run-7") }));
  `, { PROMO_RUNS_CAP: "5" });
  const j = JSON.parse(out.trim());
  assert.equal(j.count, 5);
  assert.equal(j.hasOldest, false, "最旧 run 被淘汰");
  assert.equal(j.hasNewest, true, "最新 run 保留");
});

for (const persist of ["1", "0"]) {
  test(`容量淘汰在 PROMO_PERSIST=${persist} 时仅清理最旧 run 的产物`, () => {
    const isolated = fs.mkdtempSync(path.join(os.tmpdir(), `promo-trim-${persist}-`));
    try {
      const out = runModule(`
        import fs from "node:fs";
        import path from "node:path";
        import { artifactPaths } from ${JSON.stringify(pathToFileURL(path.join(ROOT, "src/media/artifacts.js")).href)};
        import { createRun, listRuns } from ${STORE_URL};
        const oldPaths = artifactPaths("trim-old");
        const keepPaths = artifactPaths("trim-keep");
        fs.writeFileSync(oldPaths.finalVideo, "remove");
        fs.writeFileSync(keepPaths.finalVideo, "keep");
        const outside = path.join(process.env.PROMO_DATA_DIR, "outside.txt");
        fs.writeFileSync(outside, "outside");
        createRun("trim-old", { brandName: "Old" });
        createRun("trim-keep", { brandName: "Keep" });
        console.log(JSON.stringify({
          ids: listRuns().map((run) => run.runId),
          oldExists: fs.existsSync(oldPaths.runRoot),
          keepExists: fs.existsSync(keepPaths.finalVideo),
          outsideExists: fs.existsSync(outside),
        }));
      `, { PROMO_DATA_DIR: isolated, PROMO_PERSIST: persist, PROMO_RUNS_CAP: "1" });
      assert.deepEqual(JSON.parse(out.trim()), {
        ids: ["trim-keep"], oldExists: false, keepExists: true, outsideExists: true,
      });
    } finally {
      fs.rmSync(isolated, { recursive: true, force: true });
    }
  });
}

test("容量淘汰同步移除最旧 run 的 resumer", () => {
  const isolated = fs.mkdtempSync(path.join(os.tmpdir(), "promo-trim-resumer-"));
  try {
    const out = runModule(`
      import { createRun, registerResumer, getResumer } from ${STORE_URL};
      createRun("resumer-old", { brandName: "Old" });
      registerResumer("resumer-old", async () => {});
      createRun("resumer-keep", { brandName: "Keep" });
      console.log(JSON.stringify({ old: !!getResumer("resumer-old"), keep: !!getResumer("resumer-keep") }));
    `, { PROMO_DATA_DIR: isolated, PROMO_PERSIST: "0", PROMO_RUNS_CAP: "1" });
    assert.deepEqual(JSON.parse(out.trim()), { old: false, keep: false });
  } finally {
    fs.rmSync(isolated, { recursive: true, force: true });
  }
});
