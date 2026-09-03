// M4 模板库（FR-1.3）：预设种子 + CRUD + 预设防删 + 跨进程持久化。
// 与 store-persist.test.mjs 同理：用子进程验证「写盘 → 进程重启 rehydrate」。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TPL_URL = JSON.stringify(pathToFileURL(path.join(ROOT, "src/templates.js")).href);
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), "promo-tpl-"));

function runModule(code) {
  const f = path.join(DATA, "mod.mjs");
  fs.writeFileSync(f, code);
  return execFileSync(process.execPath, [f], {
    env: { ...process.env, PROMO_PERSIST: "1", PROMO_DATA_DIR: DATA },
    encoding: "utf8",
  });
}

test("模板库：预设种子 + CRUD + 预设防删", () => {
  const out = runModule(`
    import { listTemplates, saveTemplate, getTemplate, deleteTemplate } from ${TPL_URL};
    const presets = listTemplates();
    if (!(presets.length >= 5)) throw new Error("应种子 >=5 预设, got " + presets.length);
    if (!presets.every((p) => p.isPreset === true)) throw new Error("预设 isPreset 应为 true");
    const created = saveTemplate({ name: "测试模板", defaultTone: "科技感", defaultLanguage: "en", bannedWords: ["免费"], logoColor: "#0ea5e9" });
    if (!created.id) throw new Error("应分配 id");
    if (getTemplate(created.id).name !== "测试模板") throw new Error("name 不符");
    saveTemplate({ id: created.id, name: "改名" });
    if (getTemplate(created.id).name !== "改名") throw new Error("改名失败");
    if (deleteTemplate(created.id) !== true) throw new Error("删除应成功");
    if (getTemplate(created.id) !== null) throw new Error("应已删除");
    if (deleteTemplate(presets[0].id) !== false) throw new Error("预设不应被删除");
    let threw = false;
    try { saveTemplate({}); } catch (e) { threw = /name/.test(e.message); }
    if (!threw) throw new Error("空模板应抛 name 校验错误");
    console.log("OK");
  `);
  assert.match(out, /OK/);
});

test("模板库：持久化跨进程（写后 hydrate 恢复）", () => {
  const id = "persist-tpl-1";
  runModule(`
    import { saveTemplate } from ${TPL_URL};
    saveTemplate({ id: ${JSON.stringify(id)}, name: "持久化测试", defaultTone: "专业" });
    console.log("WRITTEN");
  `);
  const out = runModule(`
    import { getTemplate } from ${TPL_URL};
    const t = getTemplate(${JSON.stringify(id)});
    console.log("FOUND=" + (t ? t.name : "null"));
  `);
  assert.match(out, /FOUND=持久化测试/, "跨进程应恢复模板");
});
