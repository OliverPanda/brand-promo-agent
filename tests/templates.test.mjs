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

function runModule(code, persist = "1") {
  const f = path.join(DATA, "mod.mjs");
  fs.writeFileSync(f, code);
  return execFileSync(process.execPath, [f], {
    env: { ...process.env, PROMO_PERSIST: persist, PROMO_DATA_DIR: DATA },
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

test("模板库：PROMO_PERSIST=0 时预置仍注入内存（评审 F4）", () => {
  // FR-1.3 的「预置模板」是产品行为，不应被持久化开关劫持。
  // 修复前 hydrate() 首行 `if (!persistEnabled()) return;` 直接吞掉预置注入，
  // 导致 PROMO_PERSIST=0 下 listTemplates() 返回空数组，模板库形同不存在。
  const out = runModule(`
    import { listTemplates, deleteTemplate } from ${TPL_URL};
    const presets = listTemplates();
    console.log("COUNT=" + presets.length + " PRESET_DEL=" + deleteTemplate(presets[0].id));
  `, "0");
  assert.match(out, /COUNT=5/, "PROMO_PERSIST=0 下仍应有 5 个预置模板");
  assert.match(out, /PRESET_DEL=false/, "预置在任何持久化模式下都不可删除");
});

test("模板库：isPreset 为系统标志位，调用方无法篡改（评审 F2/F3）", () => {
  // 数据层纵深防御：即便 HTTP 层遗漏，调用方也不能伪造 isPreset 或降格预设。
  const out = runModule(`
    import { saveTemplate, getTemplate, deleteTemplate } from ${TPL_URL};
    // 1) 伪造 isPreset=true 造僵尸模板：应被强制为 false
    const z = saveTemplate({ name: "伪造预设", isPreset: true });
    console.log("FORCED_FALSE=" + (z.isPreset === false) + " DELETABLE=" + deleteTemplate(z.id));
    // 2) 伪造 id 覆盖预设并降格 isPreset：预设标志应被沿用，不可变可删
    saveTemplate({ id: "preset-tech", name: "越权改名", isPreset: false });
    console.log("PRESET_STILL=" + (getTemplate("preset-tech").isPreset === true) + " DEL=" + deleteTemplate("preset-tech"));
  `, "1");
  assert.match(out, /FORCED_FALSE=true/, "新建模板的 isPreset 应恒为 false");
  assert.match(out, /DELETABLE=true/, "自定义模板应可正常删除，不会变成僵尸");
  assert.match(out, /PRESET_STILL=true/, "预设的 isPreset 不可被降格");
  assert.match(out, /DEL=false/, "降格尝试后预设仍不可删除");
});
