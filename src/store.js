// PromoRun 运行态存储（对应 PRD §7 PromoRun）。
// M3 之前：进程内 Map，重启即清空（无历史记录）。
// M3-A：改为「内存 Map + 文件写穿（原子 temp→rename）」，进程重启后 hydrate 恢复 → 历史记录可持久化。
//
// 设计要点：
//  - 内存 Map 为唯一读缓存（SSE/列表/详情均读它，毫秒级）；每次写操作（create/update/setStep）同步写穿到磁盘 JSON。
//  - 持久化文件：<PROMO_DATA_DIR>/runs.json（默认 ./data）。原子写：先写 .tmp 再 rename，避免半截文件。
//  - PROMO_PERSIST=0 时关闭文件写穿与启动 hydrate（测试用，避免污染与 I/O）。
//  - resumers（Mastra resume 闭包，含函数）无法序列化，仅保留内存；跨重启的 suspended 运行会丢失 resumer（beta 已知限制，文档注明）。
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const DATA_DIR = process.env.PROMO_DATA_DIR || path.resolve(process.cwd(), "data");
const RUNS_FILE = path.join(DATA_DIR, "runs.json");
// 历史保留条数上限（超出淘汰最旧）。runs.json 曾因 steps.output 全量落盘涨到 ~6MB，
// 每次 setStep 同步重写阻塞事件循环 —— 双管齐下：① 落盘剥离 output（与顶层字段重复）；② 条数封顶。
const RUNS_CAP = Math.max(1, Number(process.env.PROMO_RUNS_CAP ?? 100));

function persistEnabled() {
  return process.env.PROMO_PERSIST !== "0";
}

// 落盘/ hydrate 瘦身：剥离 steps[*].output（progress 事件已把 output 实时推给前端，磁盘无需冗余；
// storyboard/脚本等大对象本就存顶层）。undefined 在 JSON.stringify 中自然消失。
function slimRun(run) {
  const steps = {};
  for (const [k, v] of Object.entries(run.steps || {})) {
    steps[k] = v && typeof v === "object" && "output" in v ? { ...v, output: undefined } : v;
  }
  return { ...run, steps };
}

/** @type {Map<string, any>} runId -> PromoRun */
const runs = new Map();
/** @type {Map<string, (resumeData: any) => Promise<any>>} runId -> resume 回调 */
const resumers = new Map();

// 启动 hydrate：从磁盘恢复历史运行（不含 resumers，见上）。
function hydrate() {
  if (!persistEnabled()) return;
  try {
    if (fs.existsSync(RUNS_FILE)) {
      const arr = JSON.parse(fs.readFileSync(RUNS_FILE, "utf8"));
      if (Array.isArray(arr)) for (const r of arr) if (r && r.runId) runs.set(r.runId, slimRun(r)); // 顺带迁移旧的大文件
    }
  } catch (e) {
    console.warn(`[store] hydrate 失败，忽略磁盘数据：`, e?.message || e);
  }
}

function persist() {
  if (!persistEnabled()) return;
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = path.join(DATA_DIR, `.runs.${process.pid}.tmp`);
    // 紧凑序列化（runs.json 纯机器读写，pretty-print 白费 ~30% 体积）
    fs.writeFileSync(tmp, JSON.stringify([...runs.values()].map(slimRun)));
    fs.renameSync(tmp, RUNS_FILE); // 原子替换
  } catch (e) {
    console.warn(`[store] 持久化失败：`, e?.message || e);
  }
}

hydrate();

export function newRunId() {
  return randomUUID();
}

export function createRun(runId, brief) {
  const run = {
    runId,
    brief,
    script: undefined,
    storyboard: undefined,
    voiceUrl: undefined,
    musicUrl: undefined,
    videoUrl: undefined,
    poster: undefined,
    storyboardGallery: [],
    srt: "",
    status: "running", // running | suspended | awaiting_delivery | success | failed
    steps: {}, // step -> { status, startedAt, doneAt, error?, output? }
    cost: [], // { step, tokens, amount }
    createdBy: brief?.brandName || "anonymous",
    createdAt: new Date().toISOString(),
    note: "",
  };
  runs.set(runId, run);
  trimRuns();
  persist();
  return run;
}

// 容量裁剪：超出 RUNS_CAP 淘汰最旧（createdAt 排序，只在超限时触发）
function trimRuns() {
  if (runs.size <= RUNS_CAP) return;
  const sorted = [...runs.values()].sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
  for (const r of sorted.slice(0, runs.size - RUNS_CAP)) runs.delete(r.runId);
}

export function getRun(runId) {
  return runs.get(runId) || null;
}

export function listRuns() {
  return [...runs.values()].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

export function updateRun(runId, patch) {
  const run = runs.get(runId);
  if (!run) return null;
  Object.assign(run, patch);
  persist();
  return run;
}

export function setStep(runId, step, state) {
  const run = runs.get(runId);
  if (!run) return;
  const prev = run.steps[step] || {};
  run.steps[step] = { ...prev, ...state };
  persist();
}

export function registerResumer(runId, fn) {
  resumers.set(runId, fn);
}

export function getResumer(runId) {
  return resumers.get(runId) || null;
}

export function clearResumer(runId) {
  resumers.delete(runId);
}
