// 进程内 PromoRun 状态表（对应 PRD §7 PromoRun）。
// M1 用内存 Map：重启即清空，不持久化（持久化推到 M3）。同时保存每个 run 的 Mastra resume 句柄，供 /approve 调用。
import { randomUUID } from "node:crypto";

/** @type {Map<string, any>} runId -> PromoRun */
const runs = new Map();
/** @type {Map<string, (resumeData: any) => Promise<any>>} runId -> resume 回调 */
const resumers = new Map();

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
    status: "running", // running | suspended | success | failed
    steps: {}, // step -> { status, startedAt, doneAt, error?, output? }
    cost: [], // { step, tokens, amount }
    createdBy: brief?.brandName || "anonymous",
    createdAt: new Date().toISOString(),
    note: "",
  };
  runs.set(runId, run);
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
  return run;
}

export function setStep(runId, step, state) {
  const run = runs.get(runId);
  if (!run) return;
  const prev = run.steps[step] || {};
  run.steps[step] = { ...prev, ...state };
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
