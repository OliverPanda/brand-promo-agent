/**
 * @file REAL 端到端成片验收脚本。
 * @description 提交一次关闭 HITL/成片门的 REAL 任务，轮询到终态后下载三件产物、ffprobe 校验，
 *              并把不含密钥的证据写入 test/_preview/real-delivery-evidence.json 供浏览器验收复用。
 */
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { CANVAS_PRESETS, DEFAULT_CANVAS_PRESET } from "../src/media/canvas.js";

const execFileAsync = promisify(execFile);
const POLL_INTERVAL_MS = 5_000;
const DEFAULT_TIMEOUT_MS = 60 * 60 * 1000;
const EVIDENCE_PATH = path.resolve(process.cwd(), "test/_preview/real-delivery-evidence.json");

/**
 * 解析命令行参数。
 * @param {string[]} argv 进程参数（已去掉 node 与脚本路径）。
 * @returns {{base: string, canvas: string, timeoutMs: number}} 归一化后的选项。
 * @example parseArgs(["--base","http://127.0.0.1:6777"]);
 */
function parseArgs(argv) {
  const valueOf = (name, fallback) => {
    const index = argv.indexOf(name);
    return index >= 0 && argv[index + 1] ? argv[index + 1] : fallback;
  };
  const base = valueOf("--base", process.env.PROMO_BASE_URL || "http://127.0.0.1:6777").replace(/\/$/, "");
  const canvas = valueOf("--canvas", DEFAULT_CANVAS_PRESET);
  if (!Object.hasOwn(CANVAS_PRESETS, canvas)) {
    throw new Error(`不支持的画布：${canvas}（可选：${Object.keys(CANVAS_PRESETS).join(" / ")}）`);
  }
  return { base, canvas, timeoutMs: Number(valueOf("--timeout-ms", DEFAULT_TIMEOUT_MS)) };
}

/**
 * 构造验收用固定简报。说明：关闭两道人工门，让脚本能一路跑到终态、无需人工介入。
 * @param {string} canvasPreset 目标画布预设标识。
 * @returns {Record<string, unknown>} Brief 请求体。
 * @example acceptanceBrief("social-portrait");
 */
function acceptanceBrief(canvasPreset) {
  return {
    brandName: "铭星链",
    productName: "智能品宣机器人",
    coreSellingPoint: "一键生成社交媒体短视频",
    audience: ["中小企业市场负责人"],
    tones: ["专业", "有温度"],
    keyMessages: ["全链路自动生成", "成片可直接投放"],
    durationSec: 15,
    styleReference: "",
    language: "zh-CN",
    voiceTone: "女声",
    hitlEnabled: false,
    finalGateEnabled: false,
    canvasPreset,
  };
}

/**
 * 带超时的 JSON 请求。
 * @param {string} url 完整地址。
 * @param {{method?: string, body?: unknown, timeoutMs?: number}} [options] 请求选项。
 * @returns {Promise<{status: number, json: any}>} 状态码与解析后的响应体。
 * @example await requestJson("http://127.0.0.1:6777/api/config");
 */
async function requestJson(url, options = {}) {
  const res = await fetch(url, {
    method: options.method || "GET",
    headers: options.body ? { "Content-Type": "application/json" } : {},
    body: options.body ? JSON.stringify(options.body) : undefined,
    signal: AbortSignal.timeout(options.timeoutMs || 60_000),
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { raw: text.slice(0, 500) };
  }
  return { status: res.status, json };
}

/**
 * 轮询运行态直到 success/failed。
 * @param {string} base 服务基地址。
 * @param {string} runId 运行标识。
 * @param {number} timeoutMs 总超时。
 * @returns {Promise<Record<string, unknown>>} 终态运行快照。
 * @example await waitForTerminal("http://127.0.0.1:6777", "run-1", 600000);
 */
async function waitForTerminal(base, runId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastStatus = "";
  while (Date.now() < deadline) {
    const { status, json } = await requestJson(`${base}/api/runs/${encodeURIComponent(runId)}`);
    if (status !== 200) throw new Error(`读取运行态失败：HTTP ${status} ${JSON.stringify(json).slice(0, 300)}`);
    lastStatus = String(json?.status || "");
    if (lastStatus === "success" || lastStatus === "failed") return json;
    process.stdout.write(`  状态 ${lastStatus || "unknown"}，继续等待…\n`);
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
  throw new Error(`等待终态超时（最后状态 ${lastStatus}）`);
}

/**
 * 下载产物并记录 HTTP 与字节证据。
 * @param {string} base 服务基地址。
 * @param {string} runId 运行标识。
 * @param {string} kind 产物类型（video/subtitles/poster）。
 * @param {string} targetPath 本地落盘路径。
 * @returns {Promise<Record<string, unknown>>} 含状态码、MIME、字节数与落盘路径的证据。
 * @example await downloadArtifact(base, runId, "video", "test/_preview/final.mp4");
 */
async function downloadArtifact(base, runId, kind, targetPath) {
  const res = await fetch(`${base}/api/runs/${encodeURIComponent(runId)}/artifacts/${kind}`, {
    signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok) throw new Error(`下载 ${kind} 失败：HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
  const buffer = Buffer.from(await res.arrayBuffer());
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.writeFileSync(targetPath, buffer);
  return {
    httpStatus: res.status,
    contentType: res.headers.get("content-type") || "",
    disposition: res.headers.get("content-disposition") || "",
    bytes: buffer.length,
    path: path.relative(process.cwd(), targetPath).split(path.sep).join("/"),
  };
}

/**
 * 用 ffprobe 读取媒体流与格式信息。
 * @param {string} file 媒体文件路径。
 * @returns {Promise<{format: Record<string, unknown>, streams: Array<Record<string, unknown>>}>} 探查结果。
 * @example await probe("test/_preview/final.mp4");
 */
async function probe(file) {
  const binary = process.env.PROMO_FFPROBE_BIN || "ffprobe";
  const { stdout } = await execFileAsync(binary, [
    "-v", "error",
    "-show_format",
    "-show_streams",
    "-print_format", "json",
    file,
  ], { timeout: 60_000, maxBuffer: 8 * 1024 * 1024 });
  return JSON.parse(stdout);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const config = await requestJson(`${options.base}/api/config`);
  if (config.status !== 200) throw new Error(`GET /api/config 失败：HTTP ${config.status}`);
  if (config.json?.mode !== "real") {
    throw new Error(`服务当前不是 REAL 模式（mode=${config.json?.mode}），验收要求真实链路；请先 POST /api/config {"providerMode":"real"}`);
  }
  console.log(`REAL 验收开始：base=${options.base} canvas=${options.canvas}`);

  const submit = await requestJson(`${options.base}/api/generate`, {
    method: "POST",
    body: acceptanceBrief(options.canvas),
  });
  if (submit.status !== 200 || !submit.json?.runId) {
    throw new Error(`POST /api/generate 失败：HTTP ${submit.status} ${JSON.stringify(submit.json).slice(0, 400)}`);
  }
  const runId = submit.json.runId;
  console.log(`已创建 run：${runId}`);

  const run = await waitForTerminal(options.base, runId, options.timeoutMs);
  if (run.status !== "success") {
    const evidence = {
      generatedAt: new Date().toISOString(),
      base: options.base,
      canvasPreset: options.canvas,
      runId,
      status: run.status,
      error: run.error || run.note || "未知失败原因",
      failedStep: Object.entries(run.steps || {}).find(([, step]) => step?.status === "failed")?.[0] || null,
      cost: run.cost || [],
    };
    fs.mkdirSync(path.dirname(EVIDENCE_PATH), { recursive: true });
    fs.writeFileSync(EVIDENCE_PATH, JSON.stringify(evidence, null, 2));
    throw new Error(`运行未成功：${evidence.error}`);
  }

  const previewDir = path.join(path.dirname(EVIDENCE_PATH), runId);
  const downloads = {
    video: await downloadArtifact(options.base, runId, "video", path.join(previewDir, "final.mp4")),
    subtitles: await downloadArtifact(options.base, runId, "subtitles", path.join(previewDir, "subtitles.srt")),
    poster: await downloadArtifact(options.base, runId, "poster", path.join(previewDir, "poster.jpg")),
  };
  const videoProbe = await probe(path.join(previewDir, "final.mp4"));
  const videoStream = (videoProbe.streams || []).find((s) => s.codec_type === "video") || {};
  const audioStream = (videoProbe.streams || []).find((s) => s.codec_type === "audio") || {};
  const manifest = run.artifactManifest || {};
  const expected = CANVAS_PRESETS[options.canvas];
  const subtitleText = fs.readFileSync(path.join(previewDir, "subtitles.srt"), "utf8");

  const evidence = {
    generatedAt: new Date().toISOString(),
    base: options.base,
    canvasPreset: options.canvas,
    runId,
    status: run.status,
    models: {
      resolved: manifest.models || {},
      video: run.brief?.videoModel || null,
      videoSelectionSource: run.brief?.modelSelectionSource || null,
      tts: run.brief?.ttsModel || null,
      music: run.brief?.musicModel || null,
    },
    video: {
      codec: videoStream.codec_name || null,
      pixFmt: videoStream.pix_fmt || null,
      width: Number(videoStream.width) || null,
      height: Number(videoStream.height) || null,
      frameRate: videoStream.r_frame_rate || null,
      durationSec: Number(videoProbe.format?.duration) || null,
      formatName: videoProbe.format?.format_name || null,
    },
    audio: {
      codec: audioStream.codec_name || null,
      sampleRate: Number(audioStream.sample_rate) || null,
      channels: Number(audioStream.channels) || null,
    },
    subtitles: {
      cues: (subtitleText.match(/-->/g) || []).length,
      hasChinese: /[\u4e00-\u9fff]/u.test(subtitleText),
      previewPath: downloads.subtitles.path,
    },
    checks: {
      canvasMatches: Number(videoStream.width) === expected.width && Number(videoStream.height) === expected.height,
      videoCodecH264: videoStream.codec_name === "h264",
      pixFmtYuv420p: videoStream.pix_fmt === "yuv420p",
      audioCodecAac: audioStream.codec_name === "aac",
      audioHasChannels: (Number(audioStream.channels) || 0) >= 1,
      manifestValidated: manifest.validated === true,
      scenesAllDynamic: Array.isArray(manifest.scenes) && manifest.scenes.length > 0 &&
        manifest.scenes.length === (run.storyboard || []).length,
      burnedSubtitleChecks: manifest.subtitles?.checks || [],
      glyphProbeRatio: manifest.subtitles?.glyphProbeRatio ?? null,
      loudness: manifest.audio || null,
    },
    artifacts: downloads,
    cost: run.cost || [],
  };
  fs.mkdirSync(path.dirname(EVIDENCE_PATH), { recursive: true });
  fs.writeFileSync(EVIDENCE_PATH, JSON.stringify(evidence, null, 2));

  const failures = Object.entries(evidence.checks)
    .filter(([key, value]) => key !== "burnedSubtitleChecks" && key !== "glyphProbeRatio" && key !== "loudness" && value !== true)
    .map(([key]) => key);
  if (failures.length > 0) throw new Error(`成片证据校验未通过：${failures.join("、")}`);
  console.log(`证据已写入 ${path.relative(process.cwd(), EVIDENCE_PATH)}`);
  console.log(`成片：${evidence.video.width}×${evidence.video.height} ${evidence.video.codec}/${evidence.video.pixFmt} + ${evidence.audio.codec}，时长 ${evidence.video.durationSec}s`);
}

main().catch((error) => {
  console.error(`验收失败：${error?.message || error}`);
  process.exit(1);
});