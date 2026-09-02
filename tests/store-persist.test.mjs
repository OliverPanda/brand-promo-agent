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

function runModule(code) {
  const f = path.join(DATA, "mod.mjs");
  fs.writeFileSync(f, code);
  return execFileSync(process.execPath, [f], {
    env: { ...process.env, PROMO_PERSIST: "1", PROMO_DATA_DIR: DATA },
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
