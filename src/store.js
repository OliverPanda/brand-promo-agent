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

function persistEnabled() {
  return process.env.PROMO_PERSIST !== "0";
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
      if (Array.isArray(arr)) for (const r of arr) if (r && r.runId) runs.set(r.runId, r);
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
    fs.writeFileSync(tmp, JSON.stringify([...runs.values()], null, 2));
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
  persist();
  return run;
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
