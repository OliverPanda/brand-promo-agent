// Mastra 工作流：品牌宣传片自动生成（对应 PRD §9 / §16.4）。
//
// 设计要点（关键经验，详见 memory）：
//   Mastra v1.63 的 suspend() 在步骤体内「始终以 undefined resolve」，且 resume() 重跑被挂起步骤后
//   **不会继续后续 DAG**（实测会卡在 suspended 步骤、下游步骤永不触发）。因此 HITL 门采用「两段式工作流」：
//     - promoScript：ingestBrief → writeScript（suspend 为人审门，是工作流的最后一步）→ 结束。
//       单步挂起/恢复，不依赖 resume 后的 DAG 续跑，行为稳定。
//     - promoVideo：prepareVideo → storyboard → scenes → voiceover → music → composite → deliver。
//       人审通过后由 server 用「已批准脚本」冷启动，无 suspend，跑到底。
//   两段通过 store 串接：server 在 script 段完成（immediate 或 approve 后）启动 video 段。
//
// runId 透传：两段用不同的 Mastra 内部 runId（script/video 后缀），但都通过 inputData.runId 携带
// 用户态 runId，使所有步骤回写同一个 PromoRun（store 以用户态 runId 为键）。
import { createWorkflow, createStep } from "@mastra/core/workflows";
import { Mastra } from "@mastra/core/mastra";
import { InMemoryStore } from "@mastra/core/storage";
import {
  generateScript,
  generateStoryboard,
  generateSceneMedia,
  generateVoiceover,
  generateMusic,
  composite,
} from "./providers.js";
import { emitProgress, emitRunDone, emitRunFailed } from "./eventBus.js";
import { updateRun, setStep, getRun } from "../store.js";

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

async function withStep(runId, step, fn) {
  setStep(runId, step, { status: "running", startedAt: Date.now() });
  emitProgress(runId, step, "step-start");
  await sleep(STEP_DELAY_MS);
  try {
    const out = await fn();
    setStep(runId, step, { status: "done", doneAt: Date.now(), output: out });
    emitProgress(runId, step, "step-done", { output: out });
    return out;
  } catch (err) {
    setStep(runId, step, { status: "failed", doneAt: Date.now(), error: String(err?.message || err) });
    emitProgress(runId, step, "step-failed", { error: String(err?.message || err) });
    updateRun(runId, { status: "failed" });
    emitRunFailed(runId, err);
    throw err;
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
      const script = await generateScript(brief);
      updateRun(rid, { script });
      if (!brief.hitlEnabled) {
        setStep(rid, STEP.SCRIPT, { status: "done", doneAt: Date.now() });
        emitProgress(rid, STEP.SCRIPT, "step-done", { output: { script } });
        return { brief, script, runId: rid };
      }
      // HITL 脚本门：suspend 等待前端 /approve（直接在 execute 体内 await）。
      updateRun(rid, { status: "suspended" });
      emitProgress(rid, STEP.SCRIPT, "step-suspended", { script });
      await suspend({ script });
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
      setStep(rid, STEP.SCRIPT, { status: "done", doneAt: Date.now() });
      emitProgress(rid, STEP.SCRIPT, "step-done", { output: { script: finalScript } });
      return { brief, script: finalScript, runId: rid };
    } catch (err) {
      setStep(rid, STEP.SCRIPT, { status: "failed", doneAt: Date.now(), error: String(err?.message || err) });
      emitProgress(rid, STEP.SCRIPT, "step-failed", { error: String(err?.message || err) });
      updateRun(rid, { status: "failed" });
      emitRunFailed(rid, err);
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
    const { brief, script } = inputData;
    return withStep(rid, STEP.STORYBOARD, async () => {
      const storyboard = await generateStoryboard(brief, script);
      updateRun(rid, { storyboard });
      return { brief, script, storyboard, runId: rid };
    });
  },
});

const generateScenes = createStep({
  id: STEP.SCENES,
  execute: async ({ runId, inputData }) => {
    const rid = inputData.runId || runId;
    const { brief, script, storyboard } = inputData;
    return withStep(rid, STEP.SCENES, async () => {
      const scenes = [];
      for (const scene of storyboard) {
        try {
          const media = await generateSceneMedia(scene, brief);
          const done = { ...scene, mediaUrl: media.mediaUrl, status: "done" };
          scenes.push(done);
          emitProgress(rid, STEP.SCENES, "step-progress", { scene: done.index, result: "done" });
        } catch (err) {
          // 单场景失败不阻断全片（PRD FR-4.3 / NFR 可靠性）
          const failed = { ...scene, mediaUrl: null, status: "failed", error: String(err?.message || err) };
          scenes.push(failed);
          emitProgress(rid, STEP.SCENES, "step-progress", { scene: failed.index, result: "failed" });
        }
      }
      updateRun(rid, { storyboard: scenes });
      return { brief, script, storyboard: scenes, runId: rid };
    });
  },
});

const voiceover = createStep({
  id: STEP.VOICE,
  execute: async ({ runId, inputData }) => {
    const rid = inputData.runId || runId;
    const { brief, script, storyboard } = inputData;
    return withStep(rid, STEP.VOICE, async () => {
      const voice = await generateVoiceover(script, brief);
      updateRun(rid, { voiceUrl: voice.voiceUrl, srt: voice.srt });
      return { brief, script, storyboard, voice, runId: rid };
    });
  },
});

const music = createStep({
  id: STEP.MUSIC,
  execute: async ({ runId, inputData }) => {
    const rid = inputData.runId || runId;
    const { brief, script, storyboard, voice } = inputData;
    return withStep(rid, STEP.MUSIC, async () => {
      const music = await generateMusic(brief, storyboard);
      updateRun(rid, { musicUrl: music.musicUrl });
      return { brief, script, storyboard, voice, music, runId: rid };
    });
  },
});

const compositeStep = createStep({
  id: STEP.COMPOSITE,
  execute: async ({ runId, inputData }) => {
    const rid = inputData.runId || runId;
    const { brief, script, storyboard, voice, music } = inputData;
    return withStep(rid, STEP.COMPOSITE, async () => {
      const result = await composite(storyboard, voice, music, brief);
      updateRun(rid, {
        poster: result.poster,
        storyboardGallery: result.storyboardGallery,
        srt: result.srt,
        videoUrl: result.videoUrl,
        note: result.note,
      });
      return { brief, script, storyboard, voice, music, composite: result, runId: rid };
    });
  },
});

const deliver = createStep({
  id: STEP.DELIVER,
  execute: async ({ runId, inputData }) => {
    const rid = inputData.runId || runId;
    const { brief, script, storyboard, voice, music, composite } = inputData;
    return withStep(rid, STEP.DELIVER, async () => {
      updateRun(rid, { status: "success" });
      const run = getRun(rid);
      emitRunDone(rid, run);
      return { runId: rid, status: "success", poster: composite.poster, gallery: composite.storyboardGallery };
    });
  },
});

export const videoWorkflow = createWorkflow({ id: "promoVideo" })
  .then(prepareVideo)
  .then(storyboard)
  .then(generateScenes)
  .then(voiceover)
  .then(music)
  .then(compositeStep)
  .then(deliver)
  .commit();

export const mastra = new Mastra({
  workflows: { promoScript: scriptWorkflow, promoVideo: videoWorkflow },
  storage: new InMemoryStore(),
});
