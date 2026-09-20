/**
 * @file 真实音频探测、拼接与字幕时间轴。
 * @description 以 ffprobe 实测语音时长生成权威场景时长和 UTF-8 SRT。
 */
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";

import { MEDIA_LIMITS, validateManagedDirectory } from "./artifacts.js";

const execFileAsync = promisify(execFileCallback);
const ILLEGAL_CONTROL_CHARACTERS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/gu;
const DEFAULT_PROCESS_TIMEOUT_MS = 120_000;

function cleanSubtitleText(value) {
  return String(value ?? "").replace(ILLEGAL_CONTROL_CHARACTERS, "").replace(/\r\n?/gu, "\n");
}

function normalizeDialogueText(value) {
  return cleanSubtitleText(value).replace(/\s+/gu, " ").trim();
}

function assertDuration(value, label = "音频时长") {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new Error(`${label}必须是大于 0 的有限数字`);
  }
}

function timestamp(milliseconds) {
  if (!Number.isInteger(milliseconds) || milliseconds < 0) throw new Error("SRT 时间戳必须是非负整数毫秒");
  const hours = Math.floor(milliseconds / 3_600_000);
  const minutes = Math.floor((milliseconds % 3_600_000) / 60_000);
  const seconds = Math.floor((milliseconds % 60_000) / 1_000);
  const millis = milliseconds % 1_000;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")},${String(millis).padStart(3, "0")}`;
}

function wrapText(text, maxCharsPerLine) {
  const characters = [...text];
  const lines = [];
  for (let offset = 0; offset < characters.length; offset += maxCharsPerLine) {
    lines.push(characters.slice(offset, offset + maxCharsPerLine).join(""));
  }
  return lines;
}

function allocateCueDurations(durationMs, characterCounts, lineIndex) {
  const cueCount = characterCounts.length;
  if (durationMs < cueCount) {
    throw new Error(`第 ${lineIndex + 1} 句字幕时间轴容量不足：${durationMs} 毫秒无法容纳 ${cueCount} 个字幕块`);
  }
  const distributableMs = durationMs - cueCount;
  const totalCharacters = characterCounts.reduce((sum, count) => sum + count, 0);
  const exactExtras = characterCounts.map((count) => distributableMs * count / totalCharacters);
  const allocations = exactExtras.map((value) => 1 + Math.floor(value));
  let remainingMs = durationMs - allocations.reduce((sum, value) => sum + value, 0);
  const priority = exactExtras
    .map((value, index) => ({ index, remainder: value - Math.floor(value) }))
    .sort((left, right) => right.remainder - left.remainder || left.index - right.index);
  for (let index = 0; index < remainingMs; index += 1) allocations[priority[index].index] += 1;
  return allocations;
}

/**
 * 使用 ffprobe 读取真实音频容器时长。
 * @param {string} filePath 本地音频绝对路径。
 * @param {{ffprobeBin?: string, execFile?: Function, processTimeoutMs?: number}} [options] 可执行文件、超时与测试边界。
 * @returns {Promise<number>} 精确到 ffprobe 输出能力的秒数。
 * @throws {Error} ffprobe 失败或返回无效 duration 时抛出。
 * @example await probeAudioDuration("D:/outputs/run/audio/voice.wav");
 */
export async function probeAudioDuration(filePath, options = {}) {
  const ffprobeBin = options.ffprobeBin || process.env.PROMO_FFPROBE_BIN || "ffprobe";
  const execute = options.execFile || execFileAsync;
  const processTimeoutMs = options.processTimeoutMs
    ?? Number(process.env.PROMO_MEDIA_PROCESS_TIMEOUT_MS || DEFAULT_PROCESS_TIMEOUT_MS);
  if (!Number.isFinite(processTimeoutMs) || processTimeoutMs <= 0) throw new Error("媒体进程超时必须是正数毫秒");
  let result;
  try {
    result = await execute(ffprobeBin, [
      "-v", "error",
      "-show_entries", "format=duration",
      "-of", "default=noprint_wrappers=1:nokey=1",
      filePath,
    ], { encoding: "utf8", windowsHide: true, maxBuffer: 1024 * 1024, timeout: processTimeoutMs, killSignal: "SIGKILL" });
  } catch (error) {
    throw new Error(`ffprobe 音频探测失败：${error?.message || error}`, { cause: error });
  }
  const durationSec = Number.parseFloat(String(result?.stdout ?? "").trim());
  if (!Number.isFinite(durationSec) || durationSec <= 0) throw new Error("ffprobe 返回了无效 duration 时长");
  return durationSec;
}

/**
 * 依序拼接语音片段，并在相邻片段之间插入固定静音。
 * @param {string[]} segmentPaths 已物化且已探测的本地语音片段。
 * @param {{workspace: string, ffmpegBin?: string, ffprobeBin?: string, execFile?: Function, processTimeoutMs?: number}} options 受管音频目录与媒体工具边界。
 * @returns {Promise<string>} 已再次通过 ffprobe 的本地 WAV 路径。
 * @throws {Error} 输入为空、工作区不可信或 ffmpeg/ffprobe 失败时抛出。
 * @example await concatenateVoiceSegments(paths, { workspace: artifactPaths("run-1").audio });
 */
export async function concatenateVoiceSegments(segmentPaths, options) {
  if (!Array.isArray(segmentPaths) || segmentPaths.length === 0) throw new Error("没有可拼接的语音片段");
  const workspace = validateManagedDirectory(options?.workspace);
  const ffmpegBin = options.ffmpegBin || process.env.PROMO_FFMPEG_BIN || "ffmpeg";
  const execute = options.execFile || execFileAsync;
  const processTimeoutMs = options.processTimeoutMs
    ?? Number(process.env.PROMO_MEDIA_PROCESS_TIMEOUT_MS || DEFAULT_PROCESS_TIMEOUT_MS);
  if (!Number.isFinite(processTimeoutMs) || processTimeoutMs <= 0) throw new Error("媒体进程超时必须是正数毫秒");
  const target = path.join(workspace, `voice-${randomUUID()}.wav`);
  const args = ["-y"];
  for (const segmentPath of segmentPaths) args.push("-i", segmentPath);

  const filters = segmentPaths.map((_, index) => (
    `[${index}:a]aresample=44100,aformat=sample_fmts=s16:channel_layouts=mono[a${index}]`
  ));
  const concatInputs = [];
  for (let index = 0; index < segmentPaths.length; index += 1) {
    concatInputs.push(`[a${index}]`);
    if (index < segmentPaths.length - 1) {
      filters.push(`anullsrc=r=44100:cl=mono:d=${MEDIA_LIMITS.voiceGapMs / 1000}[gap${index}]`);
      concatInputs.push(`[gap${index}]`);
    }
  }
  filters.push(`${concatInputs.join("")}concat=n=${concatInputs.length}:v=0:a=1[out]`);
  args.push("-filter_complex", filters.join(";"), "-map", "[out]", "-c:a", "pcm_s16le", target);
  try {
    await execute(ffmpegBin, args, {
      encoding: "utf8",
      windowsHide: true,
      maxBuffer: 8 * 1024 * 1024,
      timeout: processTimeoutMs,
      killSignal: "SIGKILL",
    });
    await probeAudioDuration(target, {
      ffprobeBin: options.ffprobeBin,
      execFile: execute,
      processTimeoutMs,
    });
    return target;
  } catch (error) {
    await fs.promises.rm(target, { force: true });
    if (/^ffprobe /u.test(String(error?.message || ""))) throw error;
    throw new Error(`ffmpeg 语音拼接失败：${error?.message || error}`, { cause: error });
  }
}

/**
 * 由每句实测语音时长构建场景时长和最多两行的字幕 cue。
 * @param {string[]} lines 已确认的逐句旁白。
 * @param {number[]} durationsSec 与旁白一一对应的实测秒数。
 * @param {{maxCharsPerLine: number}} options 字幕换行配置；句间隔固定使用 `MEDIA_LIMITS.voiceGapMs`。
 * @returns {{cues: Array<{lineIndex: number, startMs: number, endMs: number, text: string}>, durationSec: number, sceneDurationsMs: number[]}} 权威时间轴。
 * @throws {Error} 文本、时长或画布约束无效时抛出。
 * @example buildVoiceTimeline(["第一句", "第二句"], [1.4, 2.1], { maxCharsPerLine: 16 });
 */
export function buildVoiceTimeline(lines, durationsSec, options) {
  if (!Array.isArray(lines) || lines.length === 0 || lines.length !== durationsSec?.length) {
    throw new Error("旁白文本与实测时长必须非空且一一对应");
  }
  const maxCharsPerLine = options?.maxCharsPerLine;
  if (!Number.isInteger(maxCharsPerLine) || maxCharsPerLine <= 0) throw new Error("字幕每行最大字符数无效");
  const gapMs = MEDIA_LIMITS.voiceGapMs;

  const cues = [];
  const sceneDurationsMs = [];
  let cursorMs = 0;
  lines.forEach((rawLine, lineIndex) => {
    const line = normalizeDialogueText(rawLine);
    if (line.length === 0) throw new Error(`第 ${lineIndex + 1} 句旁白文本为空`);
    assertDuration(durationsSec[lineIndex], `第 ${lineIndex + 1} 句音频时长`);
    const speechMs = Math.max(1, Math.round(durationsSec[lineIndex] * 1000));
    const speechEndMs = cursorMs + speechMs;
    const wrappedLines = wrapText(line, maxCharsPerLine);
    const groups = [];
    for (let index = 0; index < wrappedLines.length; index += 2) groups.push(wrappedLines.slice(index, index + 2));
    const characterCounts = groups.map((group) => [...group.join("")].length);
    const cueDurationsMs = allocateCueDurations(speechMs, characterCounts, lineIndex);
    let cueCursorMs = cursorMs;
    groups.forEach((group, groupIndex) => {
      const startMs = cueCursorMs;
      const endMs = startMs + cueDurationsMs[groupIndex];
      cues.push({ lineIndex, startMs, endMs, text: group.join("\n") });
      cueCursorMs = endMs;
    });
    const trailingGap = lineIndex < lines.length - 1 ? gapMs : 0;
    sceneDurationsMs.push(speechMs + trailingGap);
    cursorMs = speechEndMs + trailingGap;
  });
  return { cues, durationSec: cursorMs / 1000, sceneDurationsMs };
}

/**
 * 将权威 cue 序列编码为标准 UTF-8 SRT 文本。
 * @param {Array<{startMs: number, endMs: number, text: string}>} cues 已按时间排序的字幕 cue。
 * @param {number} durationSec 权威音轨总时长，最后一个 cue 不得越界。
 * @returns {string} 使用 `HH:MM:SS,mmm` 时间戳的 SRT。
 * @throws {Error} cue 为负、倒序、重叠或总时长无效时抛出。
 * @example formatSrt([{ startMs: 0, endMs: 1000, text: "你好" }], 1);
 */
export function formatSrt(cues, durationSec) {
  assertDuration(durationSec, "权威音轨总时长");
  if (!Array.isArray(cues) || cues.length === 0) throw new Error("字幕 cue 不能为空");
  const capMs = Math.round(durationSec * 1000);
  let previousEndMs = 0;
  return `${cues.map((cue, index) => {
    const startMs = cue?.startMs;
    const originalEndMs = cue?.endMs;
    if (!Number.isInteger(startMs) || !Number.isInteger(originalEndMs) || startMs < 0 || originalEndMs <= startMs) {
      throw new Error(`第 ${index + 1} 条字幕时间戳非法或倒序`);
    }
    if (index > 0 && startMs < previousEndMs) throw new Error(`第 ${index + 1} 条字幕时间重叠`);
    const endMs = Math.min(originalEndMs, capMs);
    if (endMs <= startMs) throw new Error(`第 ${index + 1} 条字幕超出权威时长`);
    const text = cleanSubtitleText(cue.text);
    if (text.length === 0) throw new Error(`第 ${index + 1} 条字幕文本为空`);
    previousEndMs = endMs;
    return `${index + 1}\n${timestamp(startMs)} --> ${timestamp(endMs)}\n${text}`;
  }).join("\n\n")}\n`;
}
