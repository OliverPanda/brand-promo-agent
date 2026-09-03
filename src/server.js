// Express 服务：静态前端 + 生成 API + SSE 实时进度 + HITL 审核门（对应 PRD §8 / §16.5）。
// 进程内 PromoRun 状态由 store.js 维护；Mastra 两段式工作流由 workflow.js 装配（promoScript / promoVideo）。
import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mastra, publishDelivery, STEP } from "./mastra/workflow.js";
import { getProviderMode } from "./mastra/providers.js";
import { getBudgetCap } from "./cost.js";
import { getQuotaCap, checkQuota, getUsage } from "./quota.js";
import { parseBrief } from "./schemas.js";
import { listTemplates, getTemplate, saveTemplate, deleteTemplate, isPresetTemplate } from "./templates.js";
import { listCopyIdeas } from "./copyideas.js";
import { getEffectiveOneApiBase, getEffectiveOneApiKey, setRuntimeConfig, validateProviderBaseUrl, validateProviderMode, validateApiKey } from "./runtime-config.js";
import { fetchRemoteModels, demoVideoChoices } from "./models-gateway.js";
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
import { bus, emitFinalReview } from "./mastra/eventBus.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.resolve(__dirname, "../public");
const PORT = Number(process.env.PORT || 3000);

const app = express();
app.use(express.json());
app.use(express.static(PUBLIC_DIR));

// 第二段：基于已批准脚本冷启动成片工作流（无 suspend，止于 composite）。
// composite 完成后：若 finalGate 开启 → 置 awaiting_delivery 并推送 final-review 事件（成片门）；否则直接交付。
// 每次重跑用唯一 Mastra 内部 runId（attempt 后缀），避免复用 runId 冲突；用户态 runId 不变（store 键一致）。
async function runVideoPhase(runId, brief, opts = {}) {
  const attempt = (getRun(runId)?.videoAttempt || 0) + 1;
  const run = getRun(runId);
  updateRun(runId, {
    videoAttempt: attempt,
    status: "running",
    note: opts.regenerateScenes?.length ? `重新生成分镜：${opts.regenerateScenes.join(",")}` : run?.note || "",
  });
  const videoRunId = `${runId}:video:${attempt}`;
  const script = getRun(runId)?.script;
  const mrun = await mastra.getWorkflow("promoVideo").createRun({ runId: videoRunId });
  // 关键：与可工作的内联模式一致 —— 直接观察 run.start 的 Promise（detached + .then），
  // 避免在该 continuation 内 await 导致 Mastra 执行引擎卡在 storyboard 之后（Mastra v1.63 已知怪异行为）。
  return mrun.start({ inputData: { brief, script, runId } })
    .then(() => {
      const finalGate = opts.finalGate ?? brief.finalGateEnabled !== false;
      const r = getRun(runId);
      if (finalGate) {
        updateRun(runId, { status: "awaiting_delivery" });
        emitFinalReview(runId, {
          videoUrl: r.videoUrl,
          gallery: r.storyboard || r.storyboardGallery, // 优先完整分镜（含 videoUrl，成片门可预览动态片段）
          poster: r.poster,
          note: r.note,
        });
      } else {
        publishDelivery(runId); // 无成片门：composite 后直接交付
      }
    })
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
    // 脚本步若因预算/配额（Budget/QuotaExceeded）已失败，run 已标记 failed 且为终态——
    // 此时 promoScript.run.start 会「resolve 而非 reject」，不可再启动成片阶段（否则会落入
    // Mastra 嵌套上下文卡死，storyboard 后莫名置 success）。直接返回，保留 failed 终态。
    if (getRun(runId)?.status === "failed") return;
    // 非挂起且脚本已产出（HITL 关闭 / 脚本成功）：进入成片阶段。
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
  const onFinalReview = (e) => {
    if (e.runId !== runId) return;
    res.write(`event: final-review\ndata: ${JSON.stringify(e)}\n\n`); // 非终态，不关闭流
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
  bus.on("final-review", onFinalReview);
  bus.on("run-done", onDone);
  bus.on("run-failed", onFailed);

  const cleanup = () => {
    bus.off("progress", onProgress);
    bus.off("final-review", onFinalReview);
    bus.off("run-done", onDone);
    bus.off("run-failed", onFailed);
    clearResumer(runId);
  };
  req.on("close", cleanup);
});

// ── POST /api/generate/:runId/approve：HITL 审核门（脚本门 + 成片门，按 run.status 分流） ──
app.post("/api/generate/:runId/approve", async (req, res) => {
  const { runId } = req.params;
  const run = getRun(runId);
  if (!run) return res.status(404).json({ error: "run not found" });
  const { decision = "approve", edits, scenes } = req.body || {};

  // ① 脚本门（suspended）：恢复 promoScript，由 server 冷启动成片阶段。
  if (run.status === "suspended") {
    const resumer = getResumer(runId);
    if (!resumer) return res.status(409).json({ error: "no pending script approval" });
    updateRun(runId, { approval: { decision, edits } });
    try {
      await resumer({ [STEP.SCRIPT]: { decision, edits } });
      return res.json({ ok: true, gate: "script" });
    } catch (err) {
      return res.status(500).json({ error: String(err?.message || err) });
    }
  }

  // ② 成片门（awaiting_delivery）：approve → 直接交付；reject → 重新跑成片阶段（FR-9.2 指定分镜重生成）。
  if (run.status === "awaiting_delivery") {
    if (decision === "approve") {
      publishDelivery(runId);
      return res.json({ ok: true, gate: "final" });
    }
    // reject：清除旧 resumer，重跑 video 阶段（beta 下整段重生成；scenes 为意图提示，供前端展示）。
    clearResumer(runId);
    updateRun(runId, { status: "running", finalRejected: (run.finalRejected || 0) + 1 });
    setImmediate(() =>
      runVideoPhase(runId, run.brief, {
        finalGate: true,
        regenerateScenes: Array.isArray(scenes) ? scenes : [],
      }).catch((err) => {
        console.error(`[video-phase regenerate] ${runId} failed:`, err?.message || err);
        updateRun(runId, { status: "failed" });
      })
    );
    return res.json({ ok: true, gate: "final", regenerated: true });
  }

  // 终态或无挂起门
  if (run.status === "success" || run.status === "failed") {
    return res.status(409).json({ error: `run 已 ${run.status}，无待审批门` });
  }
  return res.status(409).json({ error: "no pending approval (already resumed or finished)" });
});

// ── GET /api/runs/:runId：运行态详情 ──
app.get("/api/runs/:runId", (req, res) => {
  const run = getRun(req.params.runId);
  if (!run) return res.status(404).json({ error: "run not found" });
  res.json(run);
});

// ── GET /api/runs：历史列表（持久化，重启不丢） ──
app.get("/api/runs", (_req, res) => res.json(listRuns()));

// ── GET /api/quota：账户级累计配额（FR-10.3 / M3 成本配额） ──
app.get("/api/quota", (req, res) => {
  const account = req.query.account || "anonymous";
  res.json({ account, ...checkQuota(account) });
});

// ── GET /api/admin/costs：管理员成本报表（FR-10.3），按账户/步骤聚合 ──
app.get("/api/admin/costs", (_req, res) => {
  const runs = listRuns();
  const byAccount = {};
  const byStep = {};
  let total = 0;
  for (const run of runs) {
    const acc = run.createdBy || "anonymous";
    for (const c of run.cost || []) {
      byAccount[acc] = round4((byAccount[acc] || 0) + c.amount);
      byStep[c.step] = round4((byStep[c.step] || 0) + c.amount);
      total = round4(total + c.amount);
    }
  }
  res.json({ total, byAccount, byStep, runs: runs.length });
});

// ── GET /api/config：运行模式 / 预算上限 / 配额上限（前端展示用，不含密钥） ──
app.get("/api/config", (_req, res) => {
  const llmCurrent = process.env.PROMO_LLM_MODEL || "deepseek-v4-flash";
  const imgCurrent = process.env.PROMO_IMAGE_MODEL || "doubao-seedream-4-0-250828";
  // choices = current + PROMO_*_CHOICES(env 逗号分隔扩展) + 内置默认候选，去重
  const mergeChoices = (envKey, current, fallbackList) => [
    ...new Set([
      current,
      ...(process.env[envKey] || "").split(",").map((s) => s.trim()).filter(Boolean),
      ...fallbackList,
    ]),
  ];
  res.json({
    mode: getProviderMode(),
    budgetCap: getBudgetCap(),
    quotaCap: getQuotaCap(),
    provider: getProviderMode() === "real" ? "one-api" : "demo",
    // 供应商网关（右侧「模型与服务」面板）：运行时覆盖值 > env 默认；只回显地址与「密钥是否配置」，绝不回显密钥本身。
    providerBaseUrl: getEffectiveOneApiBase(),
    apiKeySet: !!getEffectiveOneApiKey(),
    // 模型清单（用户诉求：能选模型、知道用的什么模型）。
    // llm/image 可由 Brief.llmModel / Brief.imageModel 请求级覆盖；tts/music 仅展示当前值。
    models: {
      llm: {
        label: "脚本/分镜（文本模型）",
        current: llmCurrent,
        choices: mergeChoices("PROMO_LLM_CHOICES", llmCurrent, ["deepseek-v4-flash", "deepseek-v4", "qwen3-max", "glm-5"]),
      },
      image: {
        label: "场景图（图像模型）",
        current: imgCurrent,
        choices: mergeChoices("PROMO_IMAGE_CHOICES", imgCurrent, ["doubao-seedream-4-0-250828", "doubao-seedream-3-0-t2i"]),
      },
      tts: { label: "配音（TTS）", current: process.env.PROMO_TTS_MODEL || "tiny-iceberg" },
      music: { label: "配乐", current: process.env.PROMO_MUSIC_MODEL || "mureka-v1" },
      // 视频（动态镜头）：choices 不在此静态下发 —— 由 GET /api/models 从网关实时拉取（含真实渠道）。
      // 当前值支持 env PROMO_VIDEO_MODEL 预置；选择后存 Brief.videoModel（请求级覆盖，语义同 llmModel/imageModel）。
      video: { label: "动态视频（图生/文生）", current: process.env.PROMO_VIDEO_MODEL || "" },
    },
  });
});

// ── POST /api/config：运行时配置（当前仅供应商网关地址，免重启生效）。不含密钥。 ──
app.post("/api/config", (req, res) => {
  const body = req.body || {};
  const hasAny = ["providerBaseUrl", "providerMode", "apiKey"].some((k) => body[k] !== undefined);
  if (!hasAny) {
    return res.status(400).json({ error: "无可保存配置（支持字段：providerBaseUrl / providerMode / apiKey）" });
  }
  if (body.providerBaseUrl !== undefined) {
    const chk = validateProviderBaseUrl(body.providerBaseUrl);
    if (!chk.ok) return res.status(400).json({ error: chk.error });
    setRuntimeConfig({ providerBaseUrl: chk.value });
  }
  if (body.providerMode !== undefined) {
    const chk = validateProviderMode(body.providerMode);
    if (!chk.ok) return res.status(400).json({ error: chk.error });
    setRuntimeConfig({ providerMode: chk.value });
  }
  if (body.apiKey !== undefined) {
    const chk = validateApiKey(body.apiKey);
    if (!chk.ok) return res.status(400).json({ error: chk.error });
    setRuntimeConfig({ apiKey: chk.value });
  }
  res.json({
    ok: true,
    mode: getProviderMode(),
    providerBaseUrl: getEffectiveOneApiBase(),
    apiKeySet: !!getEffectiveOneApiKey(),
    note: "配置已保存并即时生效（地址/模式/密钥，均免重启）；密钥为可写不可读——仅回显是否已配置，绝不下发明文",
  });
});

// ── GET /api/models：从供应商网关实时拉取模型清单（含视频渠道），按 llm/image/audio/video 分类 ──
// 语义：
//   - real 模式 + 网关可达 → source=gateway，返回真实分类（byType + raw 摘要）；?refresh=1 强制刷新（TTL 60s）。
//   - DEMO 模式（或未配密钥）→ source=fallback：llm/image 沿用 env+内置静态清单；video 给占位候选（仅声明路由演示，不真调）。
//   - real 模式但网关拉取失败 → 503 + error（不返回占位，避免误导用户选到不存在的渠道 id）。
app.get("/api/models", async (req, res) => {
  const refresh = req.query.refresh === "1";
  const mode = getProviderMode();
  const llmCurrent = process.env.PROMO_LLM_MODEL || "deepseek-v4-flash";
  const imgCurrent = process.env.PROMO_IMAGE_MODEL || "doubao-seedream-4-0-250828";
  const staticLlm = [...new Set([llmCurrent, ...(process.env.PROMO_LLM_CHOICES || "").split(",").map((s) => s.trim()).filter(Boolean), "deepseek-v4-flash", "deepseek-v4", "qwen3-max", "glm-5"])];
  const staticImg = [...new Set([imgCurrent, ...(process.env.PROMO_IMAGE_CHOICES || "").split(",").map((s) => s.trim()).filter(Boolean), "doubao-seedream-4-0-250828", "doubao-seedream-3-0-t2i"])];
  if (mode !== "real") {
    return res.json({
      source: "fallback",
      mode,
      note: "DEMO 离线模式：未连接网关。视频为占位候选（仅演示用），接入网关后自动列出真实渠道。",
      models: { llm: staticLlm, image: staticImg, audio: [], video: demoVideoChoices() },
    });
  }
  if (!getEffectiveOneApiBase() || !getEffectiveOneApiKey()) {
    return res.json({
      source: "fallback",
      mode,
      note: "真实模式但未配置网关/密钥：请在右侧面板填供应商地址 + API Key 保存；视频清单需连接网关后列出。",
      models: { llm: staticLlm, image: staticImg, audio: [], video: [] },
    });
  }
  try {
    const remote = await fetchRemoteModels({ refresh });
    return res.json({
      source: "gateway",
      mode,
      fetchedAt: remote.fetchedAt,
      note: "已从网关拉取真实模型清单（60s 缓存，?refresh=1 强刷）。",
      models: remote.byType,
      raw: remote.raw,
    });
  } catch (e) {
    return res.status(503).json({ source: "error", mode, error: String(e?.message || e) });
  }
});

// ── GET /api/copyideas：项目化文案灵感「换一批」──
// 结合铭星链产品线的预置文案（src/copyideas.js），按模板场景轮换；batch 越界自动环绕。
app.get("/api/copyideas", (req, res) => {
  const { preset, batch } = req.query || {};
  res.json(listCopyIdeas(typeof preset === "string" ? preset : "", Number(batch) || 0));
});

// ── 模板库（M4 / FR-1.3）：品牌预设的保存 / 复用，保证调性统一 ──
app.get("/api/templates", (_req, res) => res.json(listTemplates()));

// 新建：忽略客户端传入的 id 与 isPreset（评审 F2/F3）。
//   - id 由服务端分配，避免伪造 id="preset-tech" 覆盖预设后将其删除（预设永久丢失）；
//   - isPreset 恒 false，避免伪造 isPreset=true 造出永不可删的僵尸模板。
app.post("/api/templates", (req, res) => {
  try {
    const { id: _ignoredId, isPreset: _ignoredPreset, ...body } = req.body || {};
    const tpl = saveTemplate({ ...body, isPreset: false });
    res.status(201).json(tpl);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// 更新：要求目标已存在（否则 404）；merge 原值后再覆盖，避免部分更新静默丢字段（评审 F5）。
// isPreset 沿用原值，调用方无法把预设降格为可删、也无法把自定义模板升格为不可删（评审 F2/F3）。
app.put("/api/templates/:id", (req, res) => {
  const id = req.params.id;
  const prev = getTemplate(id);
  if (!prev) return res.status(404).json({ error: "template not found" });
  try {
    const { id: _ignoredId, isPreset: _ignoredPreset, ...body } = req.body || {};
    const tpl = saveTemplate({ ...prev, ...body, id });
    res.json(tpl);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.delete("/api/templates/:id", (req, res) => {
  const id = req.params.id;
  const t = getTemplate(id);
  if (!t) return res.status(404).json({ error: "template not found" });
  // 预设判定：标志位 + id 前缀双保险（评审 F2/F3）——标志位被污染时前缀仍可兜底。
  if (isPresetTemplate(t) || String(id).startsWith("preset-")) {
    return res.status(409).json({ error: "预设模板不可删除" });
  }
  const ok = deleteTemplate(id);
  if (!ok) return res.status(404).json({ error: "template not found" });
  res.json({ ok: true });
});

function round4(n) {
  return Math.round((n + Number.EPSILON) * 10000) / 10000;
}

// 仅当作为主入口运行（node src/server.js）时自动监听；被测试 import 时由测试自行监听随机端口。
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  // 端口自动回退（portfinder，零依赖）：默认端口（PORT 或 3000）被占用时依次向上探测。
  // 同机常驻服务常占死固定端口（如 mingstar-bff 用 3000），故不能假设默认端口可用；
  // 直接利用 listen 自身的 EADDRINUSE 事件探测，无需第三方依赖。
  const MAX_TRIES = 10;
  const start = (port, remaining = MAX_TRIES) => {
    const srv = app.listen(port);
    srv.once("error", (err) => {
      if (err.code !== "EADDRINUSE" || remaining <= 0) {
        console.error(`[brand-promo-agent] 端口 ${PORT}~${port} 均不可用：${err.message}`);
        process.exit(1);
      }
      console.warn(`[brand-promo-agent] 端口 ${port} 已被占用，自动尝试 ${port + 1} …`);
      start(port + 1, remaining - 1);
    });
    srv.once("listening", () => {
      console.log(`[brand-promo-agent] listening on http://localhost:${srv.address().port}（浏览器打开即用；DEMO 模式零密钥，真实模式需设 PROMO_PROVIDER_MODE=real）`);
    });
  };
  start(PORT);
}

export { app };
