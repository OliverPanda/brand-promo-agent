import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const html = fs.readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
function harness() {
  const nodes = new Map();
  function element(id = "") {
    const classes = new Set(["hidden"]);
    const parts = new Map();
    return { id, children: [], style: {}, textContent: "", className: "", disabled: false,
      classList: { add: c => classes.add(c), remove: c => classes.delete(c), contains: c => classes.has(c), toggle: (c, on) => on ? classes.add(c) : classes.delete(c) },
      set innerHTML(value) { this.children = []; },
      querySelector(selector) { if (!parts.has(selector)) parts.set(selector, element()); return parts.get(selector); },
      insertBefore(child, next) { const i = this.children.indexOf(next); this.children.splice(i < 0 ? this.children.length : i, 0, child); nodes.set(child.id, child); },
    };
  }
  const document = { getElementById(id) { if (!nodes.has(id)) nodes.set(id, element(id)); return nodes.get(id); }, createElement: () => element() };
  // stepRow 对不存在的行必须得到 null。
  const get = document.getElementById.bind(document);
  document.getElementById = id => id.startsWith("step-") ? nodes.get(id) || null : get(id);
  const sources = [], notices = [], rendered = [];
  class EventSource {
    constructor(url) { this.url = url; this.handlers = {}; sources.push(this); }
    addEventListener(type, fn) { this.handlers[type] = fn; }
    close() { this.closed = true; }
    send(type, data) { this.handlers[type]?.({ data: JSON.stringify(data) }); }
  }
  const storage = new Map();
  const context = vm.createContext({ document, EventSource, URL, URLSearchParams, setTimeout, clearTimeout,
    localStorage: { getItem: k => storage.get(k), setItem: (k, v) => storage.set(k, v) },
    location: { href: "http://localhost/", search: "" }, history: { replaceState() {} },
    toast: (...args) => notices.push(args), toastErr: message => notices.push([message]),
    showGate: script => rendered.push(["script", script]), onFinalReview: event => rendered.push(["final", event]), renderDelivery: run => rendered.push(["delivery", run]),
  });
  vm.runInContext('let es = null, currentRunId = "r1";', context);
  vm.runInContext(html.slice(html.indexOf("const STEP_LABEL"), html.indexOf("function showGate(")), context);
  vm.runInContext(html.slice(html.indexOf("async function approveFinal("), html.indexOf("// 单镜卡片")), context);
  return { context, nodes, sources, notices, rendered, storage, run: code => vm.runInContext(code, context) };
}

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
  h.context.fetch = async () => ({ ok: true, json: async () => ({ runId: "saved", status: "running", steps: {} }) });
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
    return { ok: true, json: async () => run };
  };
  await h.run("approveFinal(true)");
  assert.equal(h.nodes.get("step-composite")?.querySelector(".meta").textContent || "", "");
});
