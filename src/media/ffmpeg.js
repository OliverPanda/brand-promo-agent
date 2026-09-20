/**
 * @file FFmpeg 社交媒体素材归一化。
 * @description 复用受管媒体物化器，将图片和视频裁剪、转码为画布预设要求的标准资产。
 */
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolveCanvas } from "./canvas.js";
import { validateManagedDirectory } from "./artifacts.js";
import { materializeMedia } from "./materialize.js";

const execFileAsync = promisify(execFile);
const DEFAULT_TIMEOUT_MS = 120_000;

function ffmpegBinary(value) {
  return value || process.env.PROMO_FFMPEG_BIN || "ffmpeg";
}

function targetFile(workspace, prefix, extension) {
  const directory = validateManagedDirectory(workspace);
  return path.join(directory, `${prefix}-${randomUUID()}${extension}`);
}

async function runFfmpeg(binary, args, timeoutMs, output) {
  try {
    await execFileAsync(binary, args, {
      timeout: timeoutMs,
      windowsHide: true,
      maxBuffer: 4 * 1024 * 1024,
    });
    if (!fs.statSync(output, { throwIfNoEntry: false })?.isFile()) throw new Error("FFmpeg 未生成归一化媒体");
  } catch (error) {
    fs.rmSync(output, { force: true });
    const stderr = String(error?.stderr || "").split(/\r?\n/u).filter(Boolean).slice(-5).join(" | ").slice(0, 600);
    throw new Error(`FFmpeg 素材归一化失败：${stderr || error?.message || error}`, { cause: error });
  }
}

function canvasFilter(canvas) {
  return [
    `scale=${canvas.width}:${canvas.height}:force_original_aspect_ratio=increase`,
    `crop=${canvas.width}:${canvas.height}:(in_w-out_w)/2:(in_h-out_h)/2`,
    "setsar=1",
  ].join(",");
}

/**
 * 将图片安全物化后等比填充、居中裁剪为精确画布 PNG。
 * @param {{source: string, inputsWorkspace: string, scenesWorkspace: string, canvasPreset?: string, ffmpegPath?: string, timeoutMs?: number}} options 归一化选项。
 * @returns {Promise<string>} `scenesWorkspace` 内标准 PNG 的绝对路径。
 * @throws {Error} 媒体来源不安全、画布无效或 FFmpeg 失败时抛出。
 * @example await normalizeSceneImage({ source: imageUrl, inputsWorkspace: paths.inputs, scenesWorkspace: paths.scenes });
 */
export async function normalizeSceneImage({
  source,
  inputsWorkspace,
  scenesWorkspace,
  canvasPreset,
  ffmpegPath,
  timeoutMs = DEFAULT_TIMEOUT_MS,
}) {
  const canvas = resolveCanvas(canvasPreset);
  const input = await materializeMedia({ source, kind: "image", workspace: inputsWorkspace });
  const output = targetFile(scenesWorkspace, "scene-image", ".png");
  await runFfmpeg(ffmpegBinary(ffmpegPath), [
    "-y", "-v", "error", "-i", input,
    "-map", "0:v:0", "-vf", canvasFilter(canvas),
    "-frames:v", "1", "-an", "-c:v", "png", output,
  ], timeoutMs, output);
  return output;
}

/**
 * 将视频安全物化后归一化为精确画布、25fps、H.264/yuv420p、SAR 1:1 的无声 MP4。
 * 短片以末帧补齐，长片按权威场景时长裁切。
 * @param {{source: string, inputsWorkspace: string, scenesWorkspace: string, canvasPreset?: string, durationSec: number, ffmpegPath?: string, timeoutMs?: number}} options 归一化选项。
 * @returns {Promise<string>} `scenesWorkspace` 内标准 MP4 的绝对路径。
 * @throws {Error} 时长无效、媒体来源不安全或 FFmpeg 失败时抛出。
 * @example await normalizeSceneVideo({ source: videoUrl, inputsWorkspace: paths.inputs, scenesWorkspace: paths.scenes, durationSec: 3.2 });
 */
export async function normalizeSceneVideo({
  source,
  inputsWorkspace,
  scenesWorkspace,
  canvasPreset,
  durationSec,
  ffmpegPath,
  timeoutMs = DEFAULT_TIMEOUT_MS,
}) {
  if (!Number.isFinite(durationSec) || durationSec <= 0) throw new Error("视频归一化必须提供有效的权威场景时长");
  const canvas = resolveCanvas(canvasPreset);
  const input = await materializeMedia({ source, kind: "video", workspace: inputsWorkspace });
  const output = targetFile(scenesWorkspace, "scene-video", ".mp4");
  const duration = Number(durationSec).toFixed(3);
  const filter = [
    canvasFilter(canvas),
    "fps=25",
    `tpad=stop_mode=clone:stop_duration=${duration}`,
    `trim=duration=${duration}`,
    "setpts=PTS-STARTPTS",
    "format=yuv420p",
  ].join(",");
  await runFfmpeg(ffmpegBinary(ffmpegPath), [
    "-y", "-v", "error", "-i", input,
    "-map", "0:v:0", "-vf", filter,
    "-an", "-r", "25", "-fps_mode", "cfr",
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-movflags", "+faststart",
    "-t", duration, output,
  ], timeoutMs, output);
  return output;
}
