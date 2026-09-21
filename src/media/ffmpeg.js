/**
 * @file FFmpeg 社交媒体素材归一化与成片合成。
 * @description 归一化图像/视频为标准画布资产，并以 filter concat、响度混合与 ASS 中文硬字幕产出可校验成片。
 */
import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { pipeline } from "node:stream/promises";
import { resolveCanvas } from "./canvas.js";
import {
  MEDIA_LIMITS,
  promoteArtifacts,
  resolveRunArtifact,
  validateManagedDirectory,
  writeManifest,
} from "./artifacts.js";
import { formatSrt } from "./audio.js";
import { fontFamilyName } from "./font-readiness.js";

const execFileAsync = promisify(execFile);
const DEFAULT_TIMEOUT_MS = 120_000;
const FRAME_DIFF_THRESHOLD = 8;
const SUBTITLE_REGION_FRACTION = 0.3;
const LOUDNESS_TARGET_LUFS = -16;
const LOUDNESS_TOLERANCE_LUFS = 0.5;
const TRUE_PEAK_CEILING_DBTP = -1.3;

/** 渲染字形探针使用的中文样本（非预检样本，确保与实际字幕字号一致）。 */
export const CHINESE_RENDER_PROBE = "中文测试";
/** 与中文探针等长的方框对照样本；中文缺字形时会退化为相同像素。 */
export const TOFU_RENDER_PROBE = "□□□□";

const glyphProbeCache = new Map();

function ffmpegBinary(value) {
  return value || process.env.PROMO_FFMPEG_BIN || "ffmpeg";
}

function ffprobeBinary(value) {
  return value || process.env.PROMO_FFPROBE_BIN || "ffprobe";
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
  const input = await materializeMediaSource(source, inputsWorkspace, "image");
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
  const input = await materializeMediaSource(source, inputsWorkspace, "video");
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

// ───────────────────────── 成片合成 ─────────────────────────

function isInside(root, target) {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

async function materializeMediaSource(source, workspace, kind) {
  const { materializeMedia } = await import("./materialize.js");
  return materializeMedia({ source, kind, workspace });
}

function managedFile(directory, candidate, label) {
  if (typeof candidate !== "string" || candidate.trim() === "") throw new Error(`${label}缺失`);
  const realDirectory = validateManagedDirectory(directory);
  let realTarget;
  try {
    const resolved = candidate.startsWith("file:") ? fileURLToPath(new URL(candidate)) : path.resolve(candidate);
    realTarget = fs.realpathSync(resolved);
  } catch {
    throw new Error(`${label}不存在或不可读`);
  }
  if (!fs.statSync(realTarget).isFile()) throw new Error(`${label}不是普通文件`);
  if (!isInside(realDirectory, realTarget)) throw new Error(`${label}必须位于本次运行的受管工作区内`);
  return realTarget;
}

async function resolveAudioInput(paths, source, label) {
  if (typeof source !== "string" || source.trim() === "") throw new Error(`${label}缺失`);
  if (source.startsWith("data:") || /^https?:\/\//i.test(source)) {
    return materializeMediaSource(source, paths.audio, "audio");
  }
  return managedFile(paths.audio, source, label);
}

function lastStderr(error, lines = 6, limit = 600) {
  const text = String(error?.stderr || error?.message || error);
  return text.split(/\r?\n/u).filter(Boolean).slice(-lines).join(" | ").slice(0, limit);
}

async function execCapture(binary, args, options = {}) {
  const { encoding = "utf8", cwd, timeoutMs = DEFAULT_TIMEOUT_MS, maxBuffer = 16 * 1024 * 1024 } = options;
  const result = await execFileAsync(binary, args, {
    encoding,
    cwd,
    timeout: timeoutMs,
    windowsHide: true,
    maxBuffer,
    killSignal: "SIGKILL",
  });
  return {
    stdout: result.stdout,
    stderr: typeof result.stderr === "string" ? result.stderr : String(result.stderr ?? ""),
  };
}

function escapeAssText(value) {
  return String(value ?? "")
    .replace(/\\/gu, "\\\\")
    .replace(/\{/gu, "\\{")
    .replace(/\}/gu, "\\}")
    .replace(/\r\n?/gu, "\n")
    .replace(/\n/gu, "\\N");
}

function assTimestamp(milliseconds) {
  const totalCentiseconds = Math.max(0, Math.round(Number(milliseconds) / 10));
  const hours = Math.floor(totalCentiseconds / 360_000);
  const minutes = Math.floor((totalCentiseconds % 360_000) / 6_000);
  const seconds = Math.floor((totalCentiseconds % 6_000) / 100);
  const centiseconds = totalCentiseconds % 100;
  return `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}.${String(centiseconds).padStart(2, "0")}`;
}

function safeFontFamily(fontFamily) {
  const cleaned = String(fontFamily ?? "").replace(/[,\r\n]/gu, " ").trim();
  return cleaned || "Microsoft YaHei";
}

/**
 * 生成显式声明 PlayRes 的 ASS 文本；字幕文件与烧录滤镜同属 libass 管线。
 * @param {{canvas: {width: number, height: number, subtitle: {fontSize: number, marginV: number}}, fontFamily: string, cues?: Array<{startMs: number, endMs: number, text: string}>, durationSec?: number}} options 画布、字体与 cue。
 * @returns {string} UTF-8 无 BOM 的 ASS 内容。
 * @example buildAssContent({ canvas, fontFamily: "Microsoft YaHei", cues });
 */
export function buildAssContent({ canvas, fontFamily, cues = [], durationSec = 0 }) {
  const style = safeFontFamily(fontFamily);
  const capMs = Math.round(Number(durationSec) * 1000);
  const lines = [
    "[Script Info]",
    "ScriptType: v4.00+",
    `PlayResX: ${canvas.width}`,
    `PlayResY: ${canvas.height}`,
    "WrapStyle: 2",
    "ScaledBorderAndShadow: yes",
    "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    `Style: Promo,${style},${canvas.subtitle.fontSize},&H00FFFFFF,&H000000FF,&H00000000,&H7F000000,0,0,0,0,100,100,0,0,1,3,1,2,60,60,${canvas.subtitle.marginV},1`,
    "",
    "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
  ];
  for (const cue of cues) {
    const startMs = Number(cue?.startMs);
    const rawEndMs = Number(cue?.endMs);
    if (!Number.isFinite(startMs) || !Number.isFinite(rawEndMs) || rawEndMs <= startMs) throw new Error("字幕 cue 时间戳非法");
    const endMs = capMs > 0 ? Math.min(rawEndMs, capMs) : rawEndMs;
    if (endMs <= startMs) throw new Error("字幕 cue 超出权威成片时长");
    lines.push(`Dialogue: 0,${assTimestamp(startMs)},${assTimestamp(endMs)},Promo,,0,0,0,,${escapeAssText(cue.text)}`);
  }
  return `${lines.join("\n")}\n`;
}

function composeGraph({ sceneDurationsSec, canvas, totalDurationSec, assFile, fontsDir }) {
  const parts = [];
  sceneDurationsSec.forEach((durationSec, index) => {
    const duration = Number(durationSec).toFixed(3);
    parts.push(
      `[${index}:v]${canvasFilter(canvas)},fps=25,format=yuv420p,`
      + `tpad=stop_mode=clone:stop_duration=${duration},trim=duration=${duration},setpts=PTS-STARTPTS[v${index}]`,
    );
  });
  const videoInputs = sceneDurationsSec.map((_, index) => `[v${index}]`).join("");
  parts.push(`${videoInputs}concat=n=${sceneDurationsSec.length}:v=1:a=0[cat]`);
  const total = Number(totalDurationSec).toFixed(3);
  parts.push(`[cat]trim=duration=${total},setpts=PTS-STARTPTS,fps=25,format=yuv420p[nv]`);
  const assFilter = fontsDir ? `ass=${assFile}:fontsdir=${fontsDir}` : `ass=${assFile}`;
  parts.push(`[nv]${assFilter}[v]`);
  const voiceIndex = sceneDurationsSec.length;
  const musicIndex = voiceIndex + 1;
  parts.push(`[${voiceIndex}:a]loudnorm=I=-16:TP=-1.5:LRA=11[vo]`);
  parts.push(`[${musicIndex}:a]volume=0.18[mu]`);
  parts.push(`[vo][mu]amix=inputs=2:duration=longest:normalize=0[mx]`);
  parts.push(`[mx]apad,atrim=duration=${total},aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo[a]`);
  return parts.join(";");
}

async function probeMedia(ffprobe, file, timeoutMs) {
  const { stdout } = await execCapture(ffprobe, [
    "-v", "error",
    "-show_entries", "stream=codec_type,codec_name,width,height,pix_fmt,channels,sample_rate:format=duration,format_name,size",
    "-of", "json",
    file,
  ], { timeoutMs });
  return JSON.parse(stdout);
}

function cropGeometry(canvas) {
  const cropHeight = Math.max(2, Math.round((canvas.height * SUBTITLE_REGION_FRACTION) / 2) * 2);
  return { cropHeight, offsetY: canvas.height - cropHeight };
}

async function captureCroppedGray(binary, file, seekSec, canvas, timeoutMs, preFilter = "") {
  const { cropHeight, offsetY } = cropGeometry(canvas);
  const args = ["-v", "error", "-nostdin", "-i", file];
  if (seekSec > 0) args.push("-ss", Number(seekSec).toFixed(3));
  const filters = [preFilter, `crop=${canvas.width}:${cropHeight}:0:${offsetY}`, "format=gray"]
    .filter(Boolean)
    .join(",");
  args.push(
    "-frames:v", "1", "-vf", filters,
    "-f", "rawvideo", "-pix_fmt", "gray", "-",
  );
  try {
    const { stdout } = await execCapture(binary, args, { encoding: "buffer", timeoutMs, maxBuffer: 32 * 1024 * 1024 });
    return Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout ?? []);
  } catch (error) {
    throw new Error(`字幕像素校验无法抽取帧（${path.basename(file)} @ ${Number(seekSec).toFixed(2)}s）：${lastStderr(error, 3, 300)}`, { cause: error });
  }
}

function pixelDiffRatio(left, right, threshold = FRAME_DIFF_THRESHOLD) {
  const length = Math.min(left.length, right.length);
  if (length === 0) throw new Error("字幕像素校验无法读取帧数据");
  let changed = 0;
  for (let index = 0; index < length; index += 1) {
    if (Math.abs(left[index] - right[index]) > threshold) changed += 1;
  }
  return changed / length;
}

function sceneIndexAt(sceneDurationsSec, timeSec) {
  let cursor = 0;
  for (let index = 0; index < sceneDurationsSec.length; index += 1) {
    cursor += sceneDurationsSec[index];
    if (timeSec < cursor) return { index, localSec: Math.max(0, timeSec - (cursor - sceneDurationsSec[index])) };
  }
  const last = sceneDurationsSec.length - 1;
  return { index: last, localSec: Math.max(0, sceneDurationsSec[last] - 0.04) };
}

async function analyseLoudness(ffmpeg, file, timeoutMs) {
  const { stderr } = await execCapture(ffmpeg, [
    "-nostdin", "-v", "info", "-i", file,
    "-af", "loudnorm=I=-16:TP=-1.5:LRA=11:print_format=json",
    "-f", "null", "-",
  ], { timeoutMs });
  const match = /\{[\s\S]*\}/u.exec(stderr);
  if (!match) throw new Error("成片响度校验失败：无法解析 loudnorm 分析输出");
  let parsed;
  try {
    parsed = JSON.parse(match[0]);
  } catch {
    throw new Error("成片响度校验失败：loudnorm 分析输出不是合法 JSON");
  }
  const integrated = Number(parsed.output_i);
  const truePeak = Number(parsed.output_tp);
  if (!Number.isFinite(integrated) || Math.abs(integrated - LOUDNESS_TARGET_LUFS) > LOUDNESS_TOLERANCE_LUFS) {
    throw new Error(`成片响度校验失败：实测 ${Number.isFinite(integrated) ? integrated : "NaN"} LUFS，要求 ${LOUDNESS_TARGET_LUFS}±${LOUDNESS_TOLERANCE_LUFS}`);
  }
  if (!Number.isFinite(truePeak) || truePeak > TRUE_PEAK_CEILING_DBTP) {
    throw new Error(`成片真峰值校验失败：实测 ${Number.isFinite(truePeak) ? truePeak : "NaN"} dBTP，要求不高于 ${TRUE_PEAK_CEILING_DBTP}`);
  }
  return { integratedLufs: integrated, truePeakDbtp: truePeak };
}

async function sha256File(file) {
  const hash = createHash("sha256");
  await pipeline(fs.createReadStream(file), hash);
  return hash.digest("hex");
}

async function artifactDigest(file) {
  const stat = await fs.promises.stat(file);
  return { bytes: stat.size, sha256: await sha256File(file) };
}

/**
 * 渲染中文探针与方框对照，确认 libass 真的能把中文字形绘制成非方框像素。
 *
 * @param {{canvasPreset?: string, fontPath: string, fontFamily?: string, workspace: string, ffmpegPath?: string, timeoutMs?: number}} options 画布、字体与受管临时目录。
 * @returns {Promise<number>} 中文探针与方框对照在字幕区域的像素差异比例。
 * @throws {Error} 字体缺失、FFmpeg 失败或中文与方框像素完全一致时抛出。
 * @example await verifyChineseSubtitleRendering({ canvasPreset: "social-portrait", fontPath, workspace: paths.temp });
 */
export async function verifyChineseSubtitleRendering(options) {
  const canvas = resolveCanvas(options.canvasPreset);
  const workspace = validateManagedDirectory(options.workspace);
  const fontPath = String(options.fontPath || "");
  if (!fs.existsSync(fontPath)) throw new Error("真实合成缺少可用的中文字幕字体文件");
  const cacheKey = `${canvas.id}|${fontPath}`;
  if (glyphProbeCache.has(cacheKey)) return glyphProbeCache.get(cacheKey);
  const probe = (async () => {
    const ffmpeg = ffmpegBinary(options.ffmpegPath);
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const family = safeFontFamily(options.fontFamily || fontFamilyName(fontPath));
    const stamp = randomUUID();
    const fontsDirName = `fonts-${stamp}`;
    const fontsDir = path.join(workspace, fontsDirName);
    fs.mkdirSync(fontsDir, { recursive: true });
    fs.copyFileSync(fontPath, path.join(fontsDir, path.basename(fontPath)));
    const render = async (name, text) => {
      const assName = `probe-${stamp}-${name}.ass`;
      fs.writeFileSync(path.join(workspace, assName), buildAssContent({
        canvas,
        fontFamily: family,
        cues: [{ startMs: 0, endMs: 2_000, text }],
        durationSec: 2,
      }), "utf8");
      const { cropHeight, offsetY } = cropGeometry(canvas);
      const args = [
        "-v", "error", "-nostdin",
        "-f", "lavfi", "-i", `color=c=0x101010:s=${canvas.width}x${canvas.height}:r=25`,
        "-frames:v", "1",
        "-vf", `${name === "chinese" || name === "tofu" ? `ass=${assName}:fontsdir=${fontsDirName}` : `ass=${assName}`},crop=${canvas.width}:${cropHeight}:0:${offsetY},format=gray`,
        "-f", "rawvideo", "-pix_fmt", "gray", "-",
      ];
      const { stdout } = await execCapture(ffmpeg, args, { encoding: "buffer", cwd: workspace, timeoutMs, maxBuffer: 32 * 1024 * 1024 });
      return Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout ?? []);
    };
    const chinese = await render("chinese", CHINESE_RENDER_PROBE);
    const tofu = await render("tofu", TOFU_RENDER_PROBE);
    const ratio = pixelDiffRatio(chinese, tofu);
    if (!(ratio > MEDIA_LIMITS.subtitlePixelDiffRatio)) {
      throw new Error(`中文字幕字形校验失败：中文探针与方框对照像素差异 ${ratio.toFixed(5)}，未超过 ${MEDIA_LIMITS.subtitlePixelDiffRatio}`);
    }
    return ratio;
  })();
  glyphProbeCache.set(cacheKey, probe);
  try {
    return await probe;
  } catch (error) {
    glyphProbeCache.delete(cacheKey);
    throw error;
  }
}

async function ffmpegVersion(ffmpeg, timeoutMs) {
  try {
    const { stdout } = await execCapture(ffmpeg, ["-version"], { timeoutMs });
    return String(stdout).split(/\r?\n/u)[0].trim();
  } catch {
    return "unknown";
  }
}

/**
 * 校验 FFmpeg 构建包含 libass 字幕管线（`ass` 与 `subtitles` 滤镜）。
 *
 * @param {string} binary FFmpeg 可执行文件。
 * @param {{timeoutMs?: number, execFile?: Function}} [options] 超时与可注入的进程边界。
 * @returns {Promise<string>} 已确认包含 `ass` 滤镜的滤镜清单文本。
 * @throws {Error} FFmpeg 不可执行或缺少 libass 滤镜时抛出。
 * @example await assertSubtitleFilters("ffmpeg");
 */
export async function assertSubtitleFilters(binary, options = {}) {
  const execute = options.execFile || execFileAsync;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let result;
  try {
    result = await execute(binary, ["-hide_banner", "-filters"], {
      encoding: "utf8", windowsHide: true, timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, killSignal: "SIGKILL",
    });
  } catch (error) {
    throw new Error(`FFmpeg 字幕滤镜预检失败：${lastStderr(error, 3, 300)}`, { cause: error });
  }
  const filters = `${result?.stdout || ""}\n${result?.stderr || ""}`;
  if (!/(?:^|\s)ass(?:\s|$)/m.test(filters)) throw new Error("FFmpeg 缺少 ass/libass 字幕烧录滤镜，无法生成硬字幕成片");
  if (!/(?:^|\s)subtitles(?:\s|$)/m.test(filters)) throw new Error("FFmpeg 缺少 subtitles/libass 滤镜");
  return filters;
}

/**
 * 以权威语音时间轴合成带配音、配乐与中文硬字幕的成片，校验后原子提升到 run 目录。
 *
 * @param {{
 *   scenes: Array<{index?: number, videoPath: string, durationSec: number}>,
 *   voice: {voicePath?: string, voiceUrl?: string, cues: Array<{lineIndex?: number, startMs: number, endMs: number, text: string}>, durationSec: number},
 *   music: {musicPath?: string, musicUrl?: string},
 *   paths: ReturnType<typeof import("./artifacts.js").artifactPaths>,
 *   canvasPreset?: string,
 *   fontPath: string,
 *   fontFamily?: string,
 *   models?: Record<string, unknown>,
 *   ffmpegPath?: string,
 *   ffprobePath?: string,
 *   timeoutMs?: number
 * }} options 合成所需的受管片段、音轨、字体与产物目录。
 * @returns {Promise<{finalVideoPath: string, subtitlesPath: string, posterPath: string, manifestPath: string, manifest: object, srt: string, validated: true, checks: object}>} 校验并提升后的持久化产物。
 * @throws {Error} 任一输入缺失、FFmpeg 失败或成片未通过校验时抛出。
 * @example await composeFinalVideo({ scenes, voice, music, paths, fontPath });
 */
export async function composeFinalVideo(options) {
  const canvas = resolveCanvas(options.canvasPreset);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const ffmpeg = ffmpegBinary(options.ffmpegPath);
  const ffprobe = ffprobeBinary(options.ffprobePath);
  const paths = options.paths;
  if (!paths?.temp || !paths?.runRoot) throw new Error("真实合成必须提供 artifactPaths 返回的受管产物目录");
  const tempDir = validateManagedDirectory(paths.temp);
  const runId = path.basename(paths.runRoot);
  if (!fs.existsSync(ffmpeg) && options.ffmpegPath) throw new Error("真实合成缺少可执行的 FFmpeg");
  await assertSubtitleFilters(ffmpeg, { timeoutMs, execFile: options.execFile });

  const scenes = options.scenes;
  if (!Array.isArray(scenes) || scenes.length === 0) throw new Error("真实合成至少需要一个已标准化的动态片段");
  const clips = scenes.map((scene, index) => {
    const durationSec = Number(scene?.durationSec);
    if (!Number.isFinite(durationSec) || durationSec <= 0) throw new Error(`第 ${index + 1} 镜缺少权威场景时长`);
    return {
      clip: managedFile(paths.scenes, scene?.videoPath, `第 ${index + 1} 镜标准化动态片段`),
      durationSec,
    };
  });

  const cues = options.voice?.cues;
  if (!Array.isArray(cues) || cues.length === 0) throw new Error("真实合成缺少逐句字幕 cue");
  const durationSec = Number(options.voice?.durationSec);
  if (!Number.isFinite(durationSec) || durationSec <= 0) throw new Error("真实合成缺少权威音轨总时长");
  const sceneTotalSec = clips.reduce((sum, clip) => sum + clip.durationSec, 0);
  if (Math.abs(sceneTotalSec - durationSec) > MEDIA_LIMITS.durationToleranceSec) {
    throw new Error(`场景总时长 ${sceneTotalSec.toFixed(3)}s 与权威音轨 ${durationSec.toFixed(3)}s 偏差超过 ${MEDIA_LIMITS.durationToleranceSec}s`);
  }

  const srt = formatSrt(cues, durationSec);
  const voicePath = await resolveAudioInput(paths, options.voice?.voicePath || options.voice?.voiceUrl, "配音");
  const musicPath = await resolveAudioInput(paths, options.music?.musicPath || options.music?.musicUrl, "配乐");

  const fontPath = String(options.fontPath || "");
  if (!fs.existsSync(fontPath)) throw new Error("真实合成缺少可用的中文字幕字体文件");
  const fontFamily = safeFontFamily(options.fontFamily || fontFamilyName(fontPath));
  const glyphRatio = await verifyChineseSubtitleRendering({ canvasPreset: canvas.id, fontPath, fontFamily, workspace: tempDir, ffmpegPath: ffmpeg, timeoutMs });

  const assName = "final.ass";
  const baselineAssName = "baseline.ass";
  fs.writeFileSync(path.join(tempDir, assName), buildAssContent({ canvas, fontFamily, cues, durationSec }), "utf8");
  fs.writeFileSync(path.join(tempDir, baselineAssName), buildAssContent({ canvas, fontFamily, cues: [], durationSec }), "utf8");
  const fontsDirName = "fonts";
  const fontsDir = path.join(tempDir, fontsDirName);
  fs.mkdirSync(fontsDir, { recursive: true });
  fs.copyFileSync(fontPath, path.join(fontsDir, path.basename(fontPath)));

  const graph = composeGraph({
    sceneDurationsSec: clips.map((clip) => clip.durationSec),
    canvas,
    totalDurationSec: durationSec,
    assFile: assName,
    fontsDir: fontsDirName,
  });
  const args = ["-y", "-v", "error", "-nostdin"];
  for (const clip of clips) args.push("-i", clip.clip);
  args.push("-i", voicePath, "-i", musicPath);
  args.push(
    "-filter_complex", graph,
    "-map", "[v]", "-map", "[a]",
    "-c:v", "libx264", "-crf", "23", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-ac", "2",
    "-t", durationSec.toFixed(3), "-movflags", "+faststart",
    "-f", "mp4", paths.tempFinalVideo,
  );

  try {
    await fs.promises.rm(paths.tempFinalVideo, { force: true });
    await execCapture(ffmpeg, args, { cwd: tempDir, timeoutMs, maxBuffer: 8 * 1024 * 1024 });
  } catch (error) {
    await fs.promises.rm(paths.tempFinalVideo, { force: true });
    throw new Error(`FFmpeg 成片合成失败：${lastStderr(error)}`, { cause: error });
  }

  const cleanup = async () => {
    for (const file of [paths.tempFinalVideo, paths.tempSubtitles, paths.tempPoster]) {
      await fs.promises.rm(file, { force: true });
    }
  };

  try {
    const stat = await fs.promises.stat(paths.tempFinalVideo);
    if (!stat.isFile() || stat.size < MEDIA_LIMITS.minFinalVideoBytes) {
      throw new Error(`成片校验失败：文件大小 ${stat.size} 低于下限 ${MEDIA_LIMITS.minFinalVideoBytes}`);
    }

    const probed = await probeMedia(ffprobe, paths.tempFinalVideo, timeoutMs);
    const video = (probed.streams || []).find((stream) => stream.codec_type === "video");
    const audio = (probed.streams || []).find((stream) => stream.codec_type === "audio");
    if (!video) throw new Error("成片校验失败：缺少视频流");
    if (video.codec_name !== "h264") throw new Error(`成片校验失败：视频编码为 ${video.codec_name || "未知"}，要求 h264`);
    if (Number(video.width) !== canvas.width || Number(video.height) !== canvas.height) {
      throw new Error(`成片校验失败：分辨率 ${video.width}×${video.height}，要求 ${canvas.width}×${canvas.height}`);
    }
    if (video.pix_fmt !== "yuv420p") throw new Error(`成片校验失败：像素格式为 ${video.pix_fmt || "未知"}，要求 yuv420p`);
    const formatName = String(probed.format?.format_name || "");
    if (!/\b(?:mp4|mov|m4a|3gp|3g2|mj2)\b/u.test(formatName)) {
      throw new Error(`成片校验失败：容器 ${formatName || "未知"} 不是 MP4/MOV`);
    }
    const probedDurationSec = Number(probed.format?.duration);
    if (!Number.isFinite(probedDurationSec) || Math.abs(probedDurationSec - durationSec) > MEDIA_LIMITS.durationToleranceSec) {
      throw new Error(`成片校验失败：时长 ${Number.isFinite(probedDurationSec) ? probedDurationSec.toFixed(3) : "未知"}s 与权威 ${durationSec.toFixed(3)}s 偏差超过 ${MEDIA_LIMITS.durationToleranceSec}s`);
    }
    if (!audio) throw new Error("成片校验失败：缺少音轨");
    if (audio.codec_name !== "aac") throw new Error(`成片校验失败：音频编码为 ${audio.codec_name || "未知"}，要求 aac`);
    if (!(Number(audio.channels) >= 1)) throw new Error("成片校验失败：音轨为空或缺少声道");

    const loudness = await analyseLoudness(ffmpeg, paths.tempFinalVideo, timeoutMs);

    const sceneDurationsSec = clips.map((clip) => clip.durationSec);
    const firstCue = cues[0];
    const lastCue = cues[cues.length - 1];
    const subtitleChecks = [];
    for (const cue of [firstCue, lastCue]) {
      const midpointSec = ((Number(cue.startMs) + Number(cue.endMs)) / 2) / 1000;
      const { index, localSec } = sceneIndexAt(sceneDurationsSec, midpointSec);
      const withSubtitles = await captureCroppedGray(ffmpeg, paths.tempFinalVideo, midpointSec, canvas, timeoutMs);
      const baseline = await captureCroppedGray(ffmpeg, clips[index].clip, localSec, canvas, timeoutMs, `${canvasFilter(canvas)},fps=25,format=yuv420p`);
      const ratio = pixelDiffRatio(withSubtitles, baseline);
      if (!(ratio > MEDIA_LIMITS.subtitlePixelDiffRatio)) {
        throw new Error(`成片字幕校验失败：${midpointSec.toFixed(2)}s 处字幕区域像素差异 ${ratio.toFixed(5)}，未超过 ${MEDIA_LIMITS.subtitlePixelDiffRatio}`);
      }
      subtitleChecks.push({ atSec: midpointSec, ratio });
    }

    fs.writeFileSync(paths.tempSubtitles, srt, "utf8");
    const srtText = fs.readFileSync(paths.tempSubtitles, "utf8");
    const missing = cues
      .map((cue) => String(cue.text ?? "").split(/\r?\n/gu).filter(Boolean))
      .flat()
      .filter((line) => !srtText.includes(line));
    if (missing.length > 0) throw new Error(`成片字幕校验失败：SRT 缺少确认台词 ${missing.slice(0, 3).join("、")}`);
    const cueCount = (srtText.match(/-->/gu) || []).length;
    if (cueCount !== cues.length) throw new Error(`成片字幕校验失败：SRT 条目 ${cueCount} 条，确认 cue ${cues.length} 条`);

    try {
      await execCapture(ffmpeg, ["-y", "-v", "error", "-nostdin", "-i", paths.tempFinalVideo, "-frames:v", "1", "-q:v", "3", paths.tempPoster], { timeoutMs });
    } catch (error) {
      throw new Error(`成片封面抽取失败：${lastStderr(error, 3, 300)}`, { cause: error });
    }
    const posterStat = await fs.promises.stat(paths.tempPoster);
    if (!posterStat.isFile() || posterStat.size === 0) throw new Error("成片封面抽取失败：未生成 poster.jpg");

    const digests = {
      video: await artifactDigest(paths.tempFinalVideo),
      subtitles: await artifactDigest(paths.tempSubtitles),
      poster: await artifactDigest(paths.tempPoster),
    };
    const version = await ffmpegVersion(ffmpeg, timeoutMs);
    const manifest = {
      version: 1,
      runId,
      canvas: { id: canvas.id, width: canvas.width, height: canvas.height, aspectRatio: canvas.aspectRatio },
      models: { ...(options.models || {}) },
      scenes: [],
      timeline: {
        durationSec,
        sceneDurationsSec,
        cues: cues.map((cue, index) => ({ index: index + 1, lineIndex: cue.lineIndex ?? index, startMs: cue.startMs, endMs: cue.endMs })),
      },
      audio: { integratedLufs: loudness.integratedLufs, truePeakDbtp: loudness.truePeakDbtp, codec: "aac", sampleRate: Number(audio.sample_rate) || 48_000, channels: Number(audio.channels) },
      subtitles: { font: fontFamily, fontFile: path.basename(fontPath), glyphProbeRatio: glyphRatio, checks: subtitleChecks },
      ffmpeg: { version },
      artifacts: {
        finalVideo: { path: "final.mp4", ...digests.video },
        subtitles: { path: "subtitles.srt", ...digests.subtitles },
        poster: { path: "poster.jpg", ...digests.poster },
      },
      validated: true,
    };
    manifest.scenes = await Promise.all(clips.map(async (clip, index) => ({
      index: index + 1,
      durationSec: clip.durationSec,
      bytes: (await fs.promises.stat(clip.clip)).size,
    })));

    await promoteArtifacts(paths, {
      finalVideo: paths.tempFinalVideo,
      subtitles: paths.tempSubtitles,
      poster: paths.tempPoster,
    });
    writeManifest(paths, manifest);

    const finalVideoPath = resolveRunArtifact(runId, paths.finalVideo);
    resolveRunArtifact(runId, paths.subtitles);
    resolveRunArtifact(runId, paths.poster);
    const manifestPath = resolveRunArtifact(runId, paths.manifest);
    for (const [key, expected] of [["finalVideo", digests.video], ["subtitles", digests.subtitles], ["poster", digests.poster]]) {
      const target = key === "finalVideo" ? paths.finalVideo : key === "subtitles" ? paths.subtitles : paths.poster;
      const actual = await artifactDigest(target);
      if (actual.bytes !== expected.bytes || actual.sha256 !== expected.sha256) {
        throw new Error(`成片校验失败：${key} 提升后摘要不一致`);
      }
    }

    return {
      finalVideoPath,
      subtitlesPath: paths.subtitles,
      posterPath: paths.poster,
      manifestPath,
      manifest,
      srt,
      validated: true,
      checks: { loudness, subtitleChecks, glyphProbeRatio: glyphRatio, durationSec: probedDurationSec, sizeBytes: stat.size },
    };
  } catch (error) {
    await cleanup();
    throw error;
  }
}
