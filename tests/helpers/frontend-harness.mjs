/**
 * @file 前端单文件页 VM 测试夹具。
 * @description 把 public/index.html 的内联脚本切片放进 vm 上下文，用最小 DOM 桩驱动 SSE、失败重跑与交付渲染。
 */
import fs from "node:fs";
import vm from "node:vm";

export const HTML = fs.readFileSync(new URL("../../public/index.html", import.meta.url), "utf8");

// 切片边界：A 段 = 画布/模型/SSE/失败重跑；B 段 = 成片门与交付渲染。
const SLICE_A_START = "// 画布与动态视频的默认值常量：画布 id 与服务端 src/media/canvas.js 枚举一一对应。";
const SLICE_A_END = "function showGate(";
const SLICE_B_START_STUB = "async function approveFinal(";
const SLICE_B_START_REAL = "// 成片门（FR-9.2 / M3）：composite";
const SLICE_B_STUB_END = "// 单镜卡片";
const SLICE_B_DELIVERY_END = "\nrestoreRun();";

/**
 * 按起止标记切出内联脚本片段。
 * 说明：marker 缺失时 indexOf 返回 -1，slice 会静默退化成「从 0 开始」的整文件片段，
 * 导致夹具执行到无关代码后才失败、报错点远离真实原因；这里直接抛出定位信息。
 *
 * @param {string} code 内联脚本全文。
 * @param {string} start 起始标记（包含）。
 * @param {string} end 结束标记（不包含）。
 * @param {string} label 片段名，仅用于报错。
 * @returns {string} 切片后的脚本源码。
 * @example slice(HTML, SLICE_A_START, SLICE_A_END, "A");
 */
function slice(code, start, end, label) {
  const from = code.indexOf(start);
  const to = from < 0 ? -1 : code.indexOf(end, from + start.length);
  if (from < 0 || to < 0) throw new Error(`前端夹具切片失败（${label}）：start=${from} end=${to}`);
  return code.slice(from, to);
}

/**
 * 构建可执行前端内联脚本的测试上下文。
 * @param {{stubDelivery?: boolean}} [options] stubDelivery=true 时用桩替换成片门与交付渲染（用于 SSE / 恢复用例）。
 * @returns {{context: object, nodes: Map<string, object>, sources: any[], notices: any[], rendered: any[], storage: Map<string, string>, run: (code: string) => any}} 夹具句柄。
 * @example const h = harness(); h.run('openStream("r1")');
 */
export function harness(options = {}) {
  const stubDelivery = options.stubDelivery !== false;
  const nodes = new Map();
  function element(id = "") {
    const classes = new Set(["hidden"]);
    const parts = new Map();
    return {
      id, children: [], style: {}, textContent: "", className: "", disabled: false, value: "", checked: false, html: "",
      classList: {
        add: (c) => classes.add(c),
        remove: (c) => classes.delete(c),
        contains: (c) => classes.has(c),
        toggle: (c, on) => (on ? classes.add(c) : classes.delete(c)),
      },
      set innerHTML(value) { this.children = []; this.html = String(value); },
      querySelector(selector) { if (!parts.has(selector)) parts.set(selector, element()); return parts.get(selector); },
      appendChild(child) {
        this.children.push(child);
        if (child && typeof child.id === "string" && child.id) nodes.set(child.id, child);
        return child;
      },
      append(...items) { items.forEach((item) => this.appendChild(item)); },
      insertBefore(child, next) {
        const i = this.children.indexOf(next);
        this.children.splice(i < 0 ? this.children.length : i, 0, child);
        if (child && typeof child.id === "string" && child.id) nodes.set(child.id, child);
      },
      remove() {},
      focus() {},
      scrollIntoView() {},
      setAttribute() {},
      getAttribute() { return null; },
    };
  }
  const document = {
    getElementById(id) { if (!nodes.has(id)) nodes.set(id, element(id)); return nodes.get(id); },
    createElement: () => element(),
  };
  // stepRow 对不存在的行必须得到 null。
  const get = document.getElementById.bind(document);
  document.getElementById = (id) => (id.startsWith("step-") ? nodes.get(id) || null : get(id));
  const sources = [], notices = [], rendered = [];
  class EventSource {
    constructor(url) { this.url = url; this.handlers = {}; sources.push(this); }
    addEventListener(type, fn) { this.handlers[type] = fn; }
    close() { this.closed = true; }
    send(type, data) { this.handlers[type]?.({ data: JSON.stringify(data) }); }
  }
  const storage = new Map();
  const properties = {
    document, EventSource, URL, URLSearchParams, setTimeout, clearTimeout,
    localStorage: { getItem: (k) => storage.get(k), setItem: (k, v) => storage.set(k, v) },
    location: { href: "http://localhost/", search: "" },
    history: { replaceState() {} },
    toast: (...args) => notices.push(args),
    toastErr: (message) => notices.push([message]),
    showGate: (script) => rendered.push(["script", script]),
    validateForm: () => true,
    readBrandConstraints: () => ({ logoColor: undefined, bannedWords: [] }),
  };
  if (stubDelivery) {
    properties.onFinalReview = (event) => rendered.push(["final", event]);
    properties.renderDelivery = (run) => rendered.push(["delivery", run]);
  }
  const context = vm.createContext(properties);
  vm.runInContext('let es = null, currentRunId = "r1", audienceSel = new Set(), toneSel = new Set(),'
    + ' BUDGET_CAP = null, QUOTA_CAP = null, SERVER_CONFIG = null, pendingScript = null, gateVoice = [];', context);
  vm.runInContext(slice(HTML, SLICE_A_START, SLICE_A_END, "A"), context);
  vm.runInContext(stubDelivery
    ? slice(HTML, SLICE_B_START_STUB, SLICE_B_STUB_END, "B-stub")
    : slice(HTML, SLICE_B_START_REAL, SLICE_B_DELIVERY_END, "B-real"), context);
  return { context, nodes, sources, notices, rendered, storage, run: (code) => vm.runInContext(code, context) };
}