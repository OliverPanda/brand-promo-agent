// 事件总线：工作流各 Step 通过它向上层（SSE）推送实时进度。
// 单进程内 Mastra 引擎与 Express 服务共享同一 EventEmitter 实例。
import { EventEmitter } from "events";

export const bus = new EventEmitter();
bus.setMaxListeners(0); // 支持同一 runId 多个订阅者（调试/多前端）

/** 统一进度事件结构 */
export function emitProgress(runId, step, status, data = {}) {
  bus.emit("progress", { runId, step, status, ts: Date.now(), ...data });
}

/** 工作流成功终态：携带最终 PromoRun 快照 */
export function emitRunDone(runId, run) {
  bus.emit("run-done", { runId, ts: Date.now(), run });
}

/** 工作流失败终态 */
export function emitRunFailed(runId, error) {
  bus.emit("run-failed", { runId, ts: Date.now(), error: String(error?.message || error) });
}

/** 成片门（FR-9.2 / M3）：composite 完成、等待人工验收时广播预览信息（非终态） */
export function emitFinalReview(runId, preview) {
  bus.emit("final-review", { runId, ts: Date.now(), preview });
}
