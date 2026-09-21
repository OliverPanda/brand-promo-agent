// Mastra 工作流：品牌宣传片自动生成（对应 PRD §9 / §16.4）。
//
// 设计要点（关键经验，详见 memory + skill mastra-workflow-gotchas）：
//   Mastra v1.63 的 suspend() 在步骤体内「始终以 undefined resolve」，且 resume() 重跑被挂起步骤后
//   **不会继续后续 DAG**（实测会卡在 suspended 步骤、下游步骤永不触发）。因此 HITL 门采用「短工作流 + server 冷启动」：
//     - promoScript：ingestBrief → writeScript（suspend 为脚本人审门，是工作流最后一步）→ 结束。
//     - promoVideo：prepareVideo → voiceover → music → storyboard → generateScenes → composite（终点，无 deliver）。
//       脚本门通过后由 server 冷启动；composite 完成后由 server 决定走「成片门」还是「直接交付」。
//   **成片门（FR-9.2 / M3）不放在 Mastra 内 suspend**——改为 server 侧状态机（awaiting_delivery + final-review
//   事件），规避 resume 续跑陷阱；approve 时直接调用纯函数 publishDelivery（标记 success + 广播 run-done）。
//
// 成本（M2 FR-10 + M3 配额）：真实 Provider 返回 _usage，步骤经 recordCost 归集到 PromoRun.cost，
//   并执行两道闸门——单 run 预算(PROMO_BUDGET_CAP) 与 账户累计配额(PROMO_QUOTA_CAP)。DEMO 无 _usage → 不计。
//
// runId 透传：两段用不同 Mastra 内部 runId（script/video 后缀），均经 inputData.runId 携带用户态 runId，
// 使所有步骤回写同一 PromoRun（store 以用户态 runId 为键）。
import { createWorkflow, createStep } from "@mastra/core/workflows";
import { Mastra } from "@mastra/core/mastra";
import { InMemoryStore } from "@mastra/core/storage";
import {
  generateScript,
  generateStoryboard,
  generateSceneMedia,
  generateSceneVideo,
  generateVoiceover,
  generateMusic,
  composite,
  getProviderMode,
} from "./providers.js";
import { emitProgress, emitRunDone } from "./eventBus.js";
import { updateRun, setStep, getRun } from "../store.js";
import { costFor, checkBudget, getBudgetCap, BudgetExceededError } from "../cost.js";
import { checkQuota, addUsage, QuotaExceededError } from "../quota.js";
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { parseBrief } from "../schemas.js";
import { fetchRemoteModels, demoVideoChoices } from "../models-gateway.js";
import {
  getEffectiveOneApiBase,
  getEffectiveOneApiKey,
} from "../runtime-config.js";
import { artifactPaths } from "../media/artifacts.js";
import { MUSIC_SUBMIT_MODEL, TTS_FALLBACK_MODEL_DEFAULT, resolveDeliveryModels } from "../media/model-selection.js";
import { fontSupportsChinese, resolveFontFile } from "../media/font-readiness.js";

const execFileAsync = promisify(execFile);

class GenerationPreflightError extends Error {
  constructor(message, statusCode = 503) {
    super(message);
    this.name = "GenerationPreflightError";
    this.statusCode = statusCode;
  }
}

async function runCommand(bin, args) {
  return execFileAsync(bin, args, { windowsHide: true, timeout: 15_000, maxBuffer: 2 * 1024 * 1024 });
}

async function resolveFontPath(font) {
  try {
    return await resolveFontFile(font);
  } catch {
    throw new GenerationPreflightError("真实生成预检失败：配置的中文字幕字体无法精确解析；请配置字体文件路径");
  }
}

async function verifyMediaToolchain() {
  const ffmpeg = process.env.PROMO_FFMPEG_BIN || "ffmpeg";
  const ffprobe = process.env.PROMO_FFPROBE_BIN || "ffprobe";
  try {
    await runCommand(ffmpeg, ["-version"]);
  } catch {
    throw new GenerationPreflightError("真实生成预检失败：FFmpeg 不可执行，请检查 PROMO_FFMPEG_BIN");
  }
  try {
    await runCommand(ffprobe, ["-version"]);
  } catch {
    throw new GenerationPreflightError("真实生成预检失败：ffprobe 不可执行，请检查 PROMO_FFPROBE_BIN");
  }
  let filters;
  try {
    filters = await runCommand(ffmpeg, ["-hide_banner", "-filters"]);
  } catch {
    throw new GenerationPreflightError("真实生成预检失败：无法读取 FFmpeg 滤镜清单");
  }
  const filterList = `${filters.stdout || ""}\n${filters.stderr || ""}`;
  if (!/(?:^|\s)subtitles(?:\s|$)/m.test(filterList)) {
    throw new GenerationPreflightError("真实生成预检失败：FFmpeg 缺少 subtitles/libass 滤镜");
  }
  if (!/(?:^|\s)ass(?:\s|$)/m.test(filterList)) {
    throw new GenerationPreflightError("真实生成预检失败：FFmpeg 缺少 ass/libass 字幕烧录滤镜");
  }
  const font = String(process.env.PROMO_SUBTITLE_FONT || "Microsoft YaHei").trim();
  if (!font) throw new GenerationPreflightError("真实生成预检失败：未配置中文字幕字体 PROMO_SUBTITLE_FONT");
  const exactFontPath = await resolveFontPath(font);
  if (!fs.existsSync(exactFontPath) || !fontSupportsChinese(exactFontPath)) {
    throw new GenerationPreflightError("真实生成预检失败：配置字体缺少中文字幕字形（cmap 校验未通过）");
  }
}

async function verifyWritable(paths) {
  await fs.promises.access(paths.outputRoot, fs.constants.W_OK);
  const probe = path.join(paths.workspace, `.preflight-${process.pid}-${Date.now()}.tmp`);
  try {
    await fs.promises.writeFile(probe, "ok", { flag: "wx" });
  } finally {
    await fs.promises.unlink(probe).catch(() => {});
  }
}

/**
 * 在创建运行和任何付费生成调用前解析 Brief 并执行共享预检。
 *
 * @param {unknown} rawBrief 未解析的请求 Brief。
 * @param {{runId?: string, dependencies?: Record<string, Function>}} [options] 运行 ID 与边界依赖；依赖覆盖仅用于确定性测试。
 * @returns {Promise<Record<string, unknown>>} 含画布和已解析视频、TTS、配乐模型的 Brief。
 * @throws {Error} 输入错误携带 statusCode=400，环境未就绪携带 statusCode=503。
 * @example
 * await prepareGenerationBrief(body, { runId });
 */
export async function prepareGenerationBrief(rawBrief, options = {}) {
  let brief;
  try {
    brief = parseBrief(rawBrief);
  } catch (error) {
    error.statusCode = 400;
    throw error;
  }
  const dependencies = {
    verifyMediaToolchain,
    fetchRemoteModels,
    artifactPaths,
    verifyWritable,
    providerMode: getProviderMode,
    providerBase: getEffectiveOneApiBase,
    providerKey: getEffectiveOneApiKey,
    musicModel: () => process.env.PROMO_MUSIC_MODEL || "",
    ttsModel: () => process.env.PROMO_TTS_MODEL || "",
    ttsFallbackModel: () => process.env.PROMO_TTS_FALLBACK_MODEL || "",
    videoModel: () => process.env.PROMO_VIDEO_MODEL || "",
    ...options.dependencies,
  };

  if (dependencies.providerMode() !== "real") {
    return {
      ...brief,
      videoModel: brief.videoModel || dependencies.videoModel() || demoVideoChoices()[0],
      ttsModel: dependencies.ttsModel() || "speech-02-hd",
      ttsFallbackModel: dependencies.ttsFallbackModel() || TTS_FALLBACK_MODEL_DEFAULT,
      musicModel: dependencies.musicModel() || MUSIC_SUBMIT_MODEL,
      modelSelectionSource: brief.videoModel ? "manual" : dependencies.videoModel() ? "configured" : "demo",
    };
  }
  if (!dependencies.providerBase()) {
    throw new GenerationPreflightError("真实生成预检失败：未配置供应商地址 PROMO_ONEAPI_BASE_URL");
  }
  if (!dependencies.providerKey()) {
    throw new GenerationPreflightError("真实生成预检失败：未配置供应商 API Key");
  }
  if (!options.runId) throw new GenerationPreflightError("真实生成预检失败：缺少 runId");
  try {
    await dependencies.verifyMediaToolchain();
  } catch (error) {
    if (error?.statusCode === 503) throw error;
    throw new GenerationPreflightError("真实生成预检失败：本地媒体工具链不可用");
  }
  let liveModels;
  try {
    liveModels = await dependencies.fetchRemoteModels({ refresh: true });
  } catch {
    throw new GenerationPreflightError("真实生成预检失败：无法取得网关实时模型清单");
  }
  // 配乐不再有独立端点开关：固定走 Mureka 桥（mureka-song 提交 + mureka-query 轮询），
  // 端点缺失/模型缺失都由 resolveDeliveryModels 依据实时清单统一报错，避免两处规则漂移。
  const musicModel = dependencies.musicModel() || MUSIC_SUBMIT_MODEL;
  let models;
  try {
    models = resolveDeliveryModels({
      brief,
      liveModels,
      configuredVideoModel: dependencies.videoModel() || undefined,
      ttsModel: dependencies.ttsModel() || undefined,
      ttsFallbackModel: dependencies.ttsFallbackModel() || undefined,
      musicModel,
    });
  } catch (error) {
    if (error instanceof RangeError) throw new GenerationPreflightError(error.message, 400);
    throw new GenerationPreflightError(`真实生成预检失败：${error.message}`);
  }
  let paths;
  try {
    paths = dependencies.artifactPaths(options.runId);
    await dependencies.verifyWritable(paths);
  } catch (error) {
    console.error("[generation-preflight] 输出目录创建或写入失败：", error?.message || error);
    throw new GenerationPreflightError("真实生成预检失败：输出目录不可创建或写入");
  }
  return {
    ...brief,
    videoModel: models.videoModel,
    // 降级链：主模型整镜尝试耗尽后按既定优先级换渠道（上游整段故障时唯一的活路，见 providers.generateSceneVideo）。
    videoModelFallbacks: models.videoModelFallbacks,
    ttsModel: models.ttsModel,
    // null = 网关实时清单里没有可用的 omni 备用通道，运行时只走主通道。
    ttsFallbackModel: models.ttsFallbackModel,
    musicModel: models.musicModel,
    modelSelectionSource: models.source,
  };
}

const STEP = {
  INGEST: "ingestBrief",
  SCRIPT: "writeScript",
  PREPARE: "prepareVideo",
  STORYBOARD: "storyboard",
  SCENES: "generateScenes",
  VOICE: "voiceover",
  MUSIC: "music",
  COMPOSITE: "composite",
  DELIVER: "deliver",
};
export { STEP };

// DEMO 模式下故意在每个步骤间留一点时间，使 SSE 进度可见（生产模式可设 STEP_DELAY_MS=0）。
const STEP_DELAY_MS = Number(process.env.STEP_DELAY_MS ?? 400);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 归集单步成本并做两道闸门：
//  1) 单 run 预算闸门（PROMO_BUDGET_CAP，FR-10.1）—— 超限抛 BudgetExceededError。
//  2) 账户级累计配额（PROMO_QUOTA_CAP，M3「成本配额」）—— 超限抛 QuotaExceededError。
// 两道均无 _usage（DEMO）时不计量；仅真实 Provider 产生费用时才扣减配额。
function recordCost(runId, step, out) {
  const usage = out?._usage;
  if (!usage) return; // DEMO 模式无 _usage，不计量
  const c = costFor(step, usage);
  // 配额账户用部署级固定值：此前取 brief.brandName（客户端可控）→ 换个品牌名即可绕过配额。
  // createdBy 仍记录品牌名（仅作报表分组展示），不再作为限额键。
  const account = process.env.PROMO_ACCOUNT || "local";
  const costs = [...(getRun(runId)?.cost || []), c];
  updateRun(runId, { cost: costs });
  const guard = checkBudget(costs, { amount: 0 }, getBudgetCap());
  if (!guard.ok) {
    throw new BudgetExceededError(
      `预算超限：已累计 ¥${guard.total.toFixed(4)}，超过上限 ¥${guard.cap}。运行已中止。`
    );
  }
  const q = checkQuota(account, c.amount);
  if (!q.ok) {
    throw new QuotaExceededError(
      `账户 ${account} 累计配额超限：已用 ¥${q.used.toFixed(4)} + 本次 ¥${c.amount.toFixed(4)} > 上限 ¥${q.cap}。运行已中止。`
    );
  }
  addUsage(account, c.amount);
}

async function withStep(runId, step, fn) {
  setStep(runId, step, { status: "running", startedAt: Date.now(), error: undefined, doneAt: undefined });
  emitProgress(runId, step, "step-start");
  await sleep(STEP_DELAY_MS);
  try {
    const out = await fn();
    recordCost(runId, step, out);
    setStep(runId, step, { status: "done", doneAt: Date.now(), output: out });
    emitProgress(runId, step, "step-done", { output: out });
    return out;
  } catch (err) {
    let failure = err;
    if (err?._usage) {
      try {
        recordCost(runId, step, { _usage: err._usage });
      } catch (costError) {
        failure = costError;
        if (failure instanceof Error && failure.cause === undefined) failure.cause = err;
      }
    }
    setStep(runId, step, { status: "failed", doneAt: Date.now(), error: String(failure?.message || failure) });
    emitProgress(runId, step, "step-failed", { error: String(failure?.message || failure) });
    // 说明：步骤失败仍由 Mastra 决定是否重试，阶段边界统一发布最终失败。
    throw failure;
  }
}

// 注意：Mastra 的 suspend() 必须直接写在 execute 函数体内，且本版 v1.63 始终 resolve undefined、
// 不回传 resume 数据。故审批结果由 /approve 写入自有 store（run.approval），步骤被 resume「重跑」时从此处读取。
// writeScript 是 promoScript 工作流的唯一收尾步骤 → 挂起/恢复不涉及后续 DAG 续跑，行为稳定。
const writeScript = createStep({
  id: STEP.SCRIPT,
  execute: async ({ runId, inputData, suspend }) => {
    const rid = inputData.runId || runId;
    const brief = inputData.brief || inputData;
    setStep(rid, STEP.SCRIPT, { status: "running", startedAt: Date.now() });
    emitProgress(rid, STEP.SCRIPT, "step-start");
    await sleep(STEP_DELAY_MS);
    try {
      // 复用首轮已生成脚本，避免 HITL resume 重复调用 LLM（成本 + 一致性）。
      let script = getRun(rid)?.script;
      if (!script) {
        script = await generateScript(brief);
        updateRun(rid, { script });
      }
      if (!brief.hitlEnabled) {
        recordCost(rid, STEP.SCRIPT, script);
        setStep(rid, STEP.SCRIPT, { status: "done", doneAt: Date.now() });
        emitProgress(rid, STEP.SCRIPT, "step-done", { output: { script } });
        return { brief, script, runId: rid };
      }
      // HITL 脚本门：suspend 等待前端 /approve（直接在 execute 体内 await）。
      // 说明：resume 会重跑 execute，已有审批时再次 suspend 会把成功结果仍标成 suspended。
      if (!getRun(rid)?.approval) {
        updateRun(rid, { status: "suspended" });
        emitProgress(rid, STEP.SCRIPT, "step-suspended", { script });
        await suspend({ script });
      }
      const approval = getRun(rid)?.approval; // 首次挂起时尚未写入 → undefined
      if (!approval) {
        // 初次挂起：引擎已 suspended，等待 /approve 后 resume。不要返回真实结果，避免引擎误判完成。
        return { brief, script, runId: rid };
      }
      const decision = approval.decision || "approve";
      const edits = approval.edits;
      let finalScript = script;
      if (decision === "reject") finalScript = { ...script, rejected: true };
      if (edits && typeof edits === "object") {
        finalScript = { ...finalScript, ...edits, voiceover: edits.voiceover || finalScript.voiceover };
      }
      updateRun(rid, { script: finalScript, status: "running" });
      emitProgress(rid, STEP.SCRIPT, "step-approved", { decision });
      recordCost(rid, STEP.SCRIPT, finalScript); // 仅最终确认时归集一次
      setStep(rid, STEP.SCRIPT, { status: "done", doneAt: Date.now() });
      emitProgress(rid, STEP.SCRIPT, "step-done", { output: { script: finalScript } });
      return { brief, script: finalScript, runId: rid };
    } catch (err) {
      setStep(rid, STEP.SCRIPT, { status: "failed", doneAt: Date.now(), error: String(err?.message || err) });
      emitProgress(rid, STEP.SCRIPT, "step-failed", { error: String(err?.message || err) });
      throw err;
    }
  },
});

const ingestBrief = createStep({
  id: STEP.INGEST,
  execute: async ({ inputData }) => {
    const rid = inputData.runId;
    return withStep(rid, STEP.INGEST, async () => ({ brief: inputData.brief, runId: rid }));
  },
});

// 第一段：脚本生成 + HITL 门。writeScript 为收尾步骤。
export const scriptWorkflow = createWorkflow({ id: "promoScript" })
  .then(ingestBrief)
  .then(writeScript)
  .commit();

// ---- 第二段：基于已批准脚本生产成片 ----
const prepareVideo = createStep({
  id: STEP.PREPARE,
  execute: async ({ inputData }) => {
    const rid = inputData.runId;
    return withStep(rid, STEP.PREPARE, async () => ({
      brief: inputData.brief,
      script: inputData.script,
      runId: rid,
    }));
  },
});

const storyboard = createStep({
  id: STEP.STORYBOARD,
  execute: async ({ runId, inputData }) => {
    const rid = inputData.runId || runId;
    const { brief, script, voice } = inputData;
    return withStep(rid, STEP.STORYBOARD, async () => {
      // 说明：分镜在真实配音之后执行，模型只负责画面创意；每镜时长一律由实测语音时间轴覆盖，
      // 保证「分镜数量 = 确认旁白句数」「分镜总时长 = 权威音轨时长」两条硬约束。
      const proposed = await generateStoryboard(brief, script);
      assertVoiceoverMatchesStoryboard(script, proposed);
      const scenes = applyVoiceTimelineToStoryboard(script, proposed, voice);
      const tokens = (proposed || []).reduce((a, s) => a + (s._usage?.tokens || 0), 0);
      updateRun(rid, { storyboard: scenes });
      return { brief, script, voice, storyboard: scenes, runId: rid, _usage: tokens ? { tokens } : undefined };
    });
  },
});

const generateScenes = createStep({
  id: STEP.SCENES,
  execute: async ({ runId, inputData }) => {
    const rid = inputData.runId || runId;
    const { brief, script, voice, storyboard } = inputData;
    return withStep(rid, STEP.SCENES, async () => {
      assertVoiceoverMatchesStoryboard(script, storyboard);
      const scenes = [];
      // 受管工作区：图像/视频必须经共享物化器归一化后落盘到本次运行的 scenes 目录，
      // 后续预览、图生视频首帧与最终合成都只消费这些标准资产（不暴露渠道原始 URL 或本机路径）。
      const paths = artifactPaths(rid);
      const mediaOptions = { inputsWorkspace: paths.inputs, scenesWorkspace: paths.scenes };
      for (const scene of storyboard) {
        const media = await generateSceneMedia(scene, brief, mediaOptions);
        // mediaModel 透传实际使用的图像模型（brief.imageModel 请求级覆盖 > env 默认），供交付页展示
        // frameImageUrl：图像渠道的公网首帧 URL，供图生视频使用；本地 mediaPath 只用于预览与合成。
        const done = { ...scene, mediaUrl: media.mediaUrl, frameImageUrl: media.frameImageUrl, mediaModel: media.model, status: "done" };
        // 说明：REAL 模式任一动态片段失败即整步失败（不再退回静态图）；DEMO 走 stub 不计费。
        if (getProviderMode() === "real") {
          if (!brief.videoModel) throw new Error("真实成片要求动态视频模型（Brief.videoModel 未解析）");
          const vid = await generateSceneVideo(done, brief, mediaOptions);
          if (!vid?.videoPath) throw new Error(`第 ${done.index} 镜未产出标准化动态片段，真实成片不允许静态降级`);
          done.videoPath = vid.videoPath;
          done.videoUrl = vid.videoUrl;
          done.videoModel = vid.model;
          emitProgress(rid, STEP.SCENES, "step-progress", { scene: done.index, result: "video-done" });
        } else {
          if (brief.videoModel) {
            const vid = await generateSceneVideo(done, brief, mediaOptions);
            if (vid?.videoUrl) {
              done.videoUrl = vid.videoUrl;
              done.videoModel = vid.model;
            }
          }
          emitProgress(rid, STEP.SCENES, "step-progress", { scene: done.index, result: "done" });
        }
        scenes.push(done);
      }
      updateRun(rid, { storyboard: scenes });
      const images = getProviderMode() === "real" ? scenes.length : 0;
      const videos = getProviderMode() === "real" && brief.videoModel ? scenes.filter((s) => s.videoPath).length : 0;
      const usage = images ? { images } : undefined;
      if (videos) {
        usage.videos = videos;
        // 说明：发生渠道降级时真实生效模型可能与 brief.videoModel 不同，计价必须按实际出片模型，
        // 否则降级到按次计费渠道会漏算（或按错误单价估算）。
        const usedModels = [...new Set(scenes.map((s) => s.videoModel).filter(Boolean))];
        usage.videoModel = usedModels.length === 1 ? usedModels[0] : (usedModels.join(",") || brief.videoModel);
      }
      return { brief, script, voice, music, storyboard: scenes, runId: rid, _usage: usage };
    });
  },
});

function assertVoiceoverMatchesStoryboard(script, storyboard) {
  const voiceoverCount = Array.isArray(script?.voiceover) ? script.voiceover.length : 0;
  const sceneCount = Array.isArray(storyboard) ? storyboard.length : 0;
  if (voiceoverCount === 0 || voiceoverCount !== sceneCount) {
    throw new Error(`确认旁白与分镜数量不一致：旁白 ${voiceoverCount} 句，分镜 ${sceneCount} 个`);
  }
}

/**
 * 将真实配音时间轴的逐场景毫秒数写回分镜。
 * @param {{voiceover?: Array}} script 已确认脚本。
 * @param {Array<Record<string, unknown>>} storyboard 当前分镜。
 * @param {{sceneDurationsMs?: number[]}} voice 真实配音时间轴。
 * @returns {Array<Record<string, unknown>>} 带权威 `durationSec` 的新分镜数组。
 * @throws {Error} 旁白、分镜和时长数量不一致或时长非法时抛出。
 * @example applyVoiceTimelineToStoryboard(script, scenes, voice);
 */
export function applyVoiceTimelineToStoryboard(script, storyboard, voice) {
  assertVoiceoverMatchesStoryboard(script, storyboard);
  const durations = voice?.sceneDurationsMs;
  if (!Array.isArray(durations) || durations.length !== storyboard.length) {
    throw new Error(`配音场景时长与分镜数量不一致：时长 ${durations?.length || 0} 个，分镜 ${storyboard.length} 个`);
  }
  return storyboard.map((scene, index) => {
    const durationMs = durations[index];
    if (!Number.isInteger(durationMs) || durationMs <= 0) throw new Error(`第 ${index + 1} 个配音场景时长非法`);
    return { ...scene, durationSec: durationMs / 1000 };
  });
}

const voiceover = createStep({
  id: STEP.VOICE,
  execute: async ({ runId, inputData }) => {
    const rid = inputData.runId || runId;
    const { brief, script } = inputData;
    return withStep(rid, STEP.VOICE, async () => {
      // 说明：TTS/配乐必须早于任何场景图与动态视频付费调用 —— 音频通道不可用时在零素材成本处失败。
      const voice = await generateVoiceover(script, brief, { workspace: artifactPaths(rid).audio });
      updateRun(rid, { voiceUrl: voice.voiceUrl, srt: voice.srt });
      return { brief, script, voice, runId: rid, _usage: voice._usage };
    });
  },
});

const music = createStep({
  id: STEP.MUSIC,
  execute: async ({ runId, inputData }) => {
    const rid = inputData.runId || runId;
    const { brief, script, voice } = inputData;
    return withStep(rid, STEP.MUSIC, async () => {
      const music = await generateMusic(brief, undefined, { workspace: artifactPaths(rid).audio });
      updateRun(rid, { musicUrl: music.musicUrl });
      return { brief, script, voice, music, runId: rid, _usage: music._usage };
    });
  },
});

const compositeStep = createStep({
  id: STEP.COMPOSITE,
  execute: async ({ runId, inputData }) => {
    const rid = inputData.runId || runId;
    const { brief, script, storyboard, voice, music } = inputData;
    return withStep(rid, STEP.COMPOSITE, async () => {
      const paths = artifactPaths(rid);
      emitProgress(rid, STEP.COMPOSITE, "step-progress", { phase: "compositing", message: "正在合成成片" });
      emitProgress(rid, STEP.COMPOSITE, "step-progress", { phase: "validating", message: "正在校验成片" });
      const result = await composite(storyboard, voice, music, brief, { paths });
      if (getProviderMode() === "real" && result.validated !== true) {
        throw new Error("真实合成未通过成片校验，禁止进入交付");
      }
      updateRun(rid, {
        poster: result.poster,
        storyboardGallery: result.storyboardGallery,
        srt: result.srt,
        videoUrl: result.videoUrl,
        note: result.note,
        artifacts: result.artifacts,
        artifactManifest: result.artifactManifest,
      });
      return { brief, script, storyboard, voice, music, composite: result, runId: rid, _usage: result._usage };
    });
  },
});

export const videoWorkflow = createWorkflow({ id: "promoVideo" })
  .then(prepareVideo)
  .then(voiceover)
  .then(music)
  .then(storyboard)
  .then(generateScenes)
  .then(compositeStep)
  .commit();

// 成片门（FR-9.2，M3 完整化）：promoVideo 止于 composite（不自动 deliver）。
// 由 server 在 composite 完成后：若开启 finalGate → 置 awaiting_delivery 并 push final-review 事件让前端验收；
// 否则直接 publishDelivery。publishDelivery 是纯函数（不依赖 Mastra resume 续跑，规避 v1.63 陷阱），标记 success 并广播 run-done。
export function publishDelivery(runId) {
  updateRun(runId, { status: "success" });
  const run = getRun(runId);
  emitRunDone(runId, run);
  return run;
}

export const mastra = new Mastra({
  workflows: { promoScript: scriptWorkflow, promoVideo: videoWorkflow },
  storage: new InMemoryStore(),
});
