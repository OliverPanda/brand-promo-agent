// Express 服务：静态前端 + 生成 API + SSE 实时进度 + HITL 审核门（对应 PRD §8 / §16.5）。
// 进程内 PromoRun 状态由 store.js 维护；Mastra 两段式工作流由 workflow.js 装配（promoScript / promoVideo）。
import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mastra } from "./mastra/workflow.js";
import { STEP } from "./mastra/workflow.js";
import { getProviderMode } from "./mastra/providers.js";
import { getBudgetCap } from "./cost.js";
import { parseBrief } from "./schemas.js";
import {
  newRunId,
  createRun,
  getRun,
  listRuns,
  getResumer,
  registerResumer,
  clearResumer,
  updateRun,
} from "./store.js";
import { bus } from "./mastra/eventBus.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.resolve(__dirname, "../public");
const PORT = Number(process.env.PORT || 3000);

const app = express();
app.use(express.json());
app.use(express.static(PUBLIC_DIR));

// 第二段：基于已批准脚本冷启动成片工作流（无 suspend，跑到底）。
// deliver 步会写 store.status=success 并 emit run-done，供 SSE 转发。
async function runVideoPhase(runId, brief) {
  const videoRunId = `${runId}:video`;
  const script = getRun(runId)?.script;
  const run = await mastra.getWorkflow("promoVideo").createRun({ runId: videoRunId });
  // 关键：与可工作的内联模式一致 —— 直接观察 run.start 的 Promise（detached + .then），
  // 避免在该 continuation 内 await 导致 Mastra 执行引擎卡在 storyboard 之后（Mastra v1.63 已知怪异行为）。
  return run.start({ inputData: { brief, script, runId } })
    .then((res) => res)
    .catch((err) => {
      console.error(`[video-phase] ${runId} failed:`, err?.message || err);
      updateRun(runId, { status: "failed" });
      throw err;
    });
}

// 第一段：脚本生成 + HITL 门。suspend 时挂起等待 /approve；通过后进入第二段。
async function runScriptPhase(runId, brief) {
  const scriptRunId = `${runId}:script`;
  const run = await mastra.getWorkflow("promoScript").createRun({ runId: scriptRunId });
  // 审批恢复闭包：恢复被挂起的脚本工作流，完成后接力启动成片工作流。
  registerResumer(runId, async (resumeData) => {
    await run.resume({ resumeData });
    // 同上：脱离 resume 上下文，切到新 tick 启动成片工作流。
    setImmediate(() => runVideoPhase(runId, brief).catch((err) => {
      console.error(`[video-phase] ${runId} failed:`, err?.message || err);
      updateRun(runId, { status: "failed" });
    }));
  });
  try {
    const result = await run.start({ inputData: { brief, runId } });
    if (result?.status === "suspended") {
      updateRun(runId, { status: "suspended" });
      return; // 等待 /approve → resumer 接力
    }
    // 非挂起（HITL 关闭）：直接进入成片阶段。
    // 关键：不能在 promoScript 的 run.start 续跑上下文里直接 await 新工作流（Mastra AsyncLocalStorage
    // 上下文嵌套会导致新 run 卡在 storyboard 之后）。用 setImmediate 切到全新事件循环 tick，脱离父上下文。
    setImmediate(() => runVideoPhase(runId, brief).catch((err) => {
      console.error(`[video-phase] ${runId} failed:`, err?.message || err);
      updateRun(runId, { status: "failed" });
    }));
  } catch (err) {
    console.error(`[script-phase] ${runId} failed:`, err?.message || err);
    updateRun(runId, { status: "failed" });
    bus.emit("run-failed", { runId, ts: Date.now(), error: String(err?.message || err) });
  }
}

// ── POST /api/generate：提交 Brief，启动工作流，返回 runId ──
app.post("/api/generate", async (req, res) => {
  let brief;
  try {
    brief = parseBrief(req.body);
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }
  const runId = newRunId();
  createRun(runId, brief);
  // 不 await：脚本段可能在 HITL 处 suspend 或执行到底（异步），进度经 SSE 推送。
  runScriptPhase(runId, brief).catch((err) => {
    console.error(`[generate] ${runId} unexpected:`, err?.message || err);
    updateRun(runId, { status: "failed" });
  });
  res.json({ runId });
});

// ── GET /api/generate/:runId/stream：SSE 实时进度 ──
app.get("/api/generate/:runId/stream", (req, res) => {
  const { runId } = req.params;
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  res.write(`event: hello\ndata: ${JSON.stringify({ runId })}\n\n`);

  const onProgress = (e) => {
    if (e.runId !== runId) return;
    res.write(`event: progress\ndata: ${JSON.stringify(e)}\n\n`);
  };
  const finish = (type, e) => {
    if (e.runId !== runId) return;
    res.write(`event: ${type}\ndata: ${JSON.stringify(e)}\n\n`);
    cleanup();
    res.end();
  };
  const onDone = (e) => finish("run-done", e);
  const onFailed = (e) => finish("run-failed", e);

  bus.on("progress", onProgress);
  bus.on("run-done", onDone);
  bus.on("run-failed", onFailed);

  const cleanup = () => {
    bus.off("progress", onProgress);
    bus.off("run-done", onDone);
    bus.off("run-failed", onFailed);
    clearResumer(runId);
  };
  req.on("close", cleanup);
});

// ── POST /api/generate/:runId/approve：HITL 脚本门 resume ──
app.post("/api/generate/:runId/approve", async (req, res) => {
  const { runId } = req.params;
  const run = getRun(runId);
  if (!run) return res.status(404).json({ error: "run not found" });
  const resumer = getResumer(runId);
  if (!resumer) return res.status(409).json({ error: "no pending approval (already resumed or finished)" });
  const { decision = "approve", edits } = req.body || {};
  // 审批结果写入自有 store；Mastra 重跑 writeScript 步时从此读取（suspend 不回传 resume 数据）。
  updateRun(runId, { approval: { decision, edits } });
  try {
    await resumer({ [STEP.SCRIPT]: { decision, edits } });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: String(err?.message || err) });
  }
});

// ── GET /api/runs/:runId：运行态详情 ──
app.get("/api/runs/:runId", (req, res) => {
  const run = getRun(req.params.runId);
  if (!run) return res.status(404).json({ error: "run not found" });
  res.json(run);
});

// ── GET /api/runs：历史列表（进程内） ──
app.get("/api/runs", (_req, res) => res.json(listRuns()));

// ── GET /api/config：运行模式与预算上限（前端展示用，不含密钥） ──
app.get("/api/config", (_req, res) =>
  res.json({
    mode: getProviderMode(),
    budgetCap: getBudgetCap(),
    provider: getProviderMode() === "real" ? "one-api" : "demo",
  })
);

// 仅当作为主入口运行（node src/server.js）时自动监听；被测试 import 时由测试自行监听随机端口。
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  app.listen(PORT, () => {
    console.log(`[brand-promo-agent] listening on http://localhost:${PORT}`);
  });
}

export { app, runScriptPhase, runVideoPhase };
