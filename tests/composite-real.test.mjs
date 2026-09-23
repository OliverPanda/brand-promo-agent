/**
 * @file 真实成片合成测试。
 * @description 用本机 FFmpeg/libass 验证 filter concat、响度混合、中文硬字幕烧录、持久化产物校验与缺失输入的硬失败。
 */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { resolveCanvas } from "../src/media/canvas.js";
import { artifactPaths, MEDIA_LIMITS, resolveRunArtifact } from "../src/media/artifacts.js";
import { buildVoiceTimeline, concatenateVoiceSegments, probeAudioDuration } from "../src/media/audio.js";
import { styleManifest } from "../src/media/style.js";
import { configuredFontPath, fontSupportsChinese } from "../src/media/font-readiness.js";
import {
  CHINESE_RENDER_PROBE,
  TOFU_RENDER_PROBE,
  assertSubtitleFilters,
  composeFinalVideo,
  normalizeSceneVideo,
  verifyChineseSubtitleRendering,
} from "../src/media/ffmpeg.js";

// 静止纯色素材：字幕区域差异只能来自烧录的字幕，避免画面运动污染像素判定。
const SUBTITLE_LINES = ["铭星科技开场", "真实成片交付"];
// 与实现一致的底部安全区比例，用于独立复算字幕像素差异。
const SUBTITLE_REGION_FRACTION = 0.3;
const FRAME_DIFF_THRESHOLD = 8;
const FONT_PATH = configuredFontPath("Microsoft YaHei");

const originalOutputRoot = process.env.PROMO_OUTPUT_ROOT;
const originalFfmpegBin = process.env.PROMO_FFMPEG_BIN;
const outputRoot = fs.mkdtempSync(path.join(os.tmpdir(), "promo-composite-"));
process.env.PROMO_OUTPUT_ROOT = outputRoot;
process.env.PROMO_FFMPEG_BIN = "ffmpeg";

before(() => {
  execFileSync("ffmpeg", ["-version"], { stdio: "pipe" });
  execFileSync("ffprobe", ["-version"], { stdio: "pipe" });
  assert.ok(FONT_PATH && fs.existsSync(FONT_PATH), `缺少中文字幕字体：${FONT_PATH}`);
  assert.ok(fontSupportsChinese(FONT_PATH), "中文字幕字体缺少中文字形");
});

after(() => {
  if (originalOutputRoot === undefined) delete process.env.PROMO_OUTPUT_ROOT;
  else process.env.PROMO_OUTPUT_ROOT = originalOutputRoot;
  if (originalFfmpegBin === undefined) delete process.env.PROMO_FFMPEG_BIN;
  else process.env.PROMO_FFMPEG_BIN = originalFfmpegBin;
  fs.rmSync(outputRoot, { recursive: true, force: true });
});

function synthTone(target, { durationSec, frequency }) {
  execFileSync("ffmpeg", [
    "-y", "-v", "error", "-f", "lavfi", "-i", `sine=frequency=${frequency}:duration=${durationSec}`,
    "-c:a", "pcm_s16le", target,
  ], { stdio: "pipe" });
}

function synthClip(target, { color, durationSec }) {
  execFileSync("ffmpeg", [
    "-y", "-v", "error", "-f", "lavfi", "-i", `color=c=${color}:s=640x360:d=${durationSec}:r=24`,
    "-an", "-c:v", "libx264", "-pix_fmt", "yuv420p", target,
  ], { stdio: "pipe" });
}

function probeFinal(file) {
  const parsed = JSON.parse(execFileSync("ffprobe", [
    "-v", "error",
    "-show_entries", "stream=codec_type,codec_name,width,height,pix_fmt,channels,sample_rate:format=duration,format_name,size",
    "-of", "json",
    file,
  ], { stdio: "pipe" }).toString());
  return {
    format: parsed.format,
    video: (parsed.streams || []).find((stream) => stream.codec_type === "video"),
    audio: (parsed.streams || []).find((stream) => stream.codec_type === "audio"),
  };
}

/** 独立复算 EBU 响度：不接受 composeFinalVideo 自报的 checks。 */
function measureLoudness(file) {
  const run = spawnSync("ffmpeg", [
    "-nostdin", "-v", "info", "-i", file,
    "-af", "loudnorm=I=-16:TP=-1.5:LRA=11:print_format=json",
    "-f", "null", "-",
  ], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  const match = /\{[\s\S]*\}/u.exec(String(run.stderr || ""));
  assert.ok(match, `无法解析 loudnorm 输出：${String(run.stderr || "").slice(-400)}`);
  return JSON.parse(match[0]);
}

function cropBottomGray(file, seekSec, canvas) {
  const cropHeight = Math.max(2, Math.round((canvas.height * SUBTITLE_REGION_FRACTION) / 2) * 2);
  const offsetY = canvas.height - cropHeight;
  const args = ["-v", "error", "-nostdin", "-i", file];
  if (seekSec > 0) args.push("-ss", Number(seekSec).toFixed(3));
  args.push(
    "-frames:v", "1",
    "-vf", `crop=${canvas.width}:${cropHeight}:0:${offsetY},format=gray`,
    "-f", "rawvideo", "-pix_fmt", "gray", "-",
  );
  return execFileSync("ffmpeg", args, { stdio: ["ignore", "pipe", "pipe"], maxBuffer: 32 * 1024 * 1024 });
}

function pixelDiffRatio(left, right) {
  const length = Math.min(left.length, right.length);
  assert.ok(length > 0, "字幕像素校验无法读取帧数据");
  let changed = 0;
  for (let index = 0; index < length; index += 1) {
    if (Math.abs(left[index] - right[index]) > FRAME_DIFF_THRESHOLD) changed += 1;
  }
  return changed / length;
}

function sceneAt(scenes, timeSec) {
  let cursor = 0;
  for (let index = 0; index < scenes.length; index += 1) {
    const durationSec = scenes[index].durationSec;
    if (timeSec < cursor + durationSec) return { index, localSec: Math.max(0, timeSec - cursor) };
    cursor += durationSec;
  }
  const last = scenes.length - 1;
  return { index: last, localSec: Math.max(0, scenes[last].durationSec - 0.04) };
}

let scenarioIndex = 0;

/**
 * 构造与真实工作流一致的一次运行：受管目录内的标准化片段 + 逐句配音 + 权威时间轴 + 配乐。
 * @param {{preset: string, speechDurationsSec?: number[], tag?: string, stylePreset?: string, styleDescription?: string}} options 画布预设、逐句语音时长与全片风格。
 * @returns {Promise<object>} 合成所需的分镜、音轨、时间轴、风格与受管路径。
 */
async function buildScenario({ preset, speechDurationsSec = [1.2, 1.3], tag = "compose", stylePreset, styleDescription }) {
  const runId = `${tag}-${scenarioIndex += 1}`;
  const paths = artifactPaths(runId);
  const canvas = resolveCanvas(preset);
  const segments = speechDurationsSec.map((durationSec, index) => {
    const target = path.join(paths.audio, `voice-segment-${index + 1}.wav`);
    synthTone(target, { durationSec, frequency: 420 + index * 140 });
    return target;
  });
  const measuredSec = [];
  for (const segment of segments) measuredSec.push(await probeAudioDuration(segment));
  const voicePath = await concatenateVoiceSegments(segments, { workspace: paths.audio });
  const timeline = buildVoiceTimeline(SUBTITLE_LINES, measuredSec, { maxCharsPerLine: canvas.subtitle.maxCharsPerLine });

  const scenes = [];
  for (let index = 0; index < timeline.sceneDurationsMs.length; index += 1) {
    const durationSec = timeline.sceneDurationsMs[index] / 1000;
    const raw = path.join(paths.inputs, `scene-${index + 1}.mp4`);
    synthClip(raw, { color: index % 2 === 0 ? "0x101010" : "0x181818", durationSec });
    const videoPath = await normalizeSceneVideo({
      source: raw,
      inputsWorkspace: paths.inputs,
      scenesWorkspace: paths.scenes,
      canvasPreset: preset,
      durationSec,
    });
    scenes.push({ index: index + 1, videoPath, durationSec });
  }

  const musicPath = path.join(paths.audio, "music.wav");
  synthTone(musicPath, { durationSec: timeline.durationSec + 1.5, frequency: 220 });
  const style = styleManifest({ stylePreset, styleDescription });
  return { runId, paths, canvas, timeline, scenes, voicePath, musicPath, style };
}

function composeOptions(scenario, overrides = {}) {
  return {
    scenes: scenario.scenes,
    voice: {
      voicePath: scenario.voicePath,
      cues: scenario.timeline.cues,
      durationSec: scenario.timeline.durationSec,
    },
    music: { musicPath: scenario.musicPath },
    paths: scenario.paths,
    canvasPreset: scenario.canvas.id,
    style: scenario.style,
    fontPath: FONT_PATH,
    ...overrides,
  };
}

function dataUrl(file, mime) {
  return `data:${mime};base64,${fs.readFileSync(file).toString("base64")}`;
}

function listen(handler) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(handler);
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

/** 断言成片与四件产物同时满足画布、编码、时长、响度、字幕与清单契约。 */
function assertDeliverable(scenario, result) {
  const { paths, canvas, timeline } = scenario;
  assert.equal(result.validated, true, "应返回通过校验的成片结果");

  for (const [key, target] of Object.entries({
    finalVideo: paths.finalVideo,
    subtitles: paths.subtitles,
    poster: paths.poster,
    manifest: paths.manifest,
  })) {
    assert.ok(fs.existsSync(target), `${key} 应提升到持久 run 目录`);
    assert.equal(path.dirname(fs.realpathSync(target)), fs.realpathSync(paths.runRoot), `${key} 必须位于本次运行根目录`);
  }
  assert.equal(result.finalVideoPath, resolveRunArtifact(scenario.runId, paths.finalVideo));
  assert.equal(result.subtitlesPath, paths.subtitles);
  assert.equal(result.posterPath, paths.poster);
  assert.equal(result.manifestPath, resolveRunArtifact(scenario.runId, paths.manifest));

  const bytes = fs.statSync(paths.finalVideo).size;
  assert.ok(bytes >= MEDIA_LIMITS.minFinalVideoBytes, `成片体积 ${bytes} 应不低于 ${MEDIA_LIMITS.minFinalVideoBytes}`);

  const probed = probeFinal(paths.finalVideo);
  assert.equal(probed.video.codec_name, "h264");
  assert.equal(probed.video.pix_fmt, "yuv420p");
  assert.equal(Number(probed.video.width), canvas.width);
  assert.equal(Number(probed.video.height), canvas.height);
  assert.match(String(probed.format.format_name), /mp4|mov/);
  assert.ok(
    Math.abs(Number(probed.format.duration) - timeline.durationSec) <= MEDIA_LIMITS.durationToleranceSec,
    `时长 ${probed.format.duration}s 应≈${timeline.durationSec}s`,
  );
  assert.equal(probed.audio.codec_name, "aac");
  assert.equal(Number(probed.audio.channels), 2);
  assert.equal(Number(probed.audio.sample_rate), 48_000);

  const srt = fs.readFileSync(paths.subtitles, "utf8");
  assert.equal(srt, result.srt);
  for (const line of SUBTITLE_LINES) {
    assert.equal(srt.split(line).length - 1, 1, `SRT 应恰好包含一次「${line}」`);
  }
  assert.equal((srt.match(/-->/gu) || []).length, timeline.cues.length);

  const manifest = JSON.parse(fs.readFileSync(paths.manifest, "utf8"));
  assert.deepEqual(manifest, result.manifest);
  assert.equal(manifest.validated, true);
  assert.equal(manifest.runId, scenario.runId);
  assert.deepEqual(manifest.canvas, {
    id: canvas.id,
    width: canvas.width,
    height: canvas.height,
    aspectRatio: canvas.aspectRatio,
  });
  // 交付清单必须记录风格，否则无法核对「成品画风 == 简报风格」（PRD §16.13）。
  assert.deepEqual(manifest.style, scenario.style);
  assert.deepEqual(manifest.timeline.sceneDurationsSec, scenario.scenes.map((scene) => scene.durationSec));
  assert.deepEqual(
    manifest.timeline.cues.map((cue) => [cue.startMs, cue.endMs]),
    timeline.cues.map((cue) => [cue.startMs, cue.endMs]),
  );
  assert.equal(manifest.audio.sampleRate, 48_000);
  assert.equal(manifest.audio.channels, 2);
  assert.match(String(manifest.ffmpeg.version), /ffmpeg/i);
  assert.equal(manifest.subtitles.fontFile, path.basename(FONT_PATH));
  assert.ok(manifest.subtitles.glyphProbeRatio > MEDIA_LIMITS.subtitlePixelDiffRatio);
  for (const [key, target] of Object.entries({
    finalVideo: paths.finalVideo,
    subtitles: paths.subtitles,
    poster: paths.poster,
  })) {
    assert.equal(manifest.artifacts[key].sha256, createHash("sha256").update(fs.readFileSync(target)).digest("hex"), `${key} 摘要应匹配`);
    assert.equal(manifest.artifacts[key].bytes, fs.statSync(target).size, `${key} 体积应匹配`);
    assert.equal(manifest.artifacts[key].path, path.basename(target));
  }

  const loudness = measureLoudness(paths.finalVideo);
  assert.ok(Math.abs(Number(loudness.output_i) + 16) <= 0.5, `整体响度应为 -16±0.5 LUFS（实际 ${loudness.output_i}）`);
  assert.ok(Number(loudness.output_tp) <= -1.3, `真峰值应不高于 -1.3 dBTP（实际 ${loudness.output_tp}）`);

  for (const cue of [timeline.cues[0], timeline.cues[timeline.cues.length - 1]]) {
    const midpointSec = (cue.startMs + cue.endMs) / 2_000;
    const { index, localSec } = sceneAt(scenario.scenes, midpointSec);
    const withSubtitles = cropBottomGray(paths.finalVideo, midpointSec, canvas);
    const baseline = cropBottomGray(scenario.scenes[index].videoPath, localSec, canvas);
    const ratio = pixelDiffRatio(withSubtitles, baseline);
    assert.ok(
      ratio > MEDIA_LIMITS.subtitlePixelDiffRatio,
      `${midpointSec.toFixed(2)}s 字幕区域像素差异 ${ratio.toFixed(5)} 应超过 ${MEDIA_LIMITS.subtitlePixelDiffRatio}`,
    );
  }
}

for (const preset of ["social-portrait", "social-landscape", "social-square"]) {
  test(`${preset}：真实合成产出带中文硬字幕的可交付 MP4`, async () => {
    const scenario = await buildScenario({ preset });
    const result = await composeFinalVideo(composeOptions(scenario));
    assertDeliverable(scenario, result);
  });
}

test("全片风格固化：非默认预设与自定义描述经合成管线写入交付清单", async () => {
  const variants = [
    { stylePreset: "anime", styleDescription: undefined, expected: { preset: "anime", label: "动漫", description: "" } },
    { stylePreset: "custom", styleDescription: "手绘水彩绘本风，暖色调平涂", expected: { preset: "custom", label: "自定义", description: "手绘水彩绘本风，暖色调平涂" } },
  ];
  for (const variant of variants) {
    const scenario = await buildScenario({
      preset: "social-square",
      speechDurationsSec: [0.8, 0.8],
      tag: `style-${variant.stylePreset}`,
      stylePreset: variant.stylePreset,
      styleDescription: variant.styleDescription,
    });
    const result = await composeFinalVideo(composeOptions(scenario));
    assertDeliverable(scenario, result);
    assert.deepEqual(
      result.manifest.style,
      variant.expected,
      `交付清单必须记录本次实际风格，而不是默认值（${variant.stylePreset}）`,
    );
    assert.deepEqual(
      JSON.parse(fs.readFileSync(scenario.paths.manifest, "utf8")).style,
      variant.expected,
      "落盘 manifest 的风格必须与本次简报一致",
    );
  }
});

/** 说明：渠道降级后 manifest.models.video 不再等于实际出片模型，逐镜审计字段必须落盘（PRD §16.13.2）。*/
test("生成审计：manifest.scenes 逐镜记录实际出片模型与输入形态", async () => {
  const scenario = await buildScenario({ preset: "social-square", speechDurationsSec: [0.8, 0.8], tag: "audit" });
  const audited = scenario.scenes.map((scene, index) => ({
    ...scene,
    videoModel: index === 0 ? "doubao-seedance-2-0-260128" : "minimax-h3",
    videoMode: index === 0 ? "image-to-video" : "text-to-video",
  }));
  const result = await composeFinalVideo(composeOptions(scenario, { scenes: audited }));
  assert.ok(result.validated, "带审计字段的片段必须照常通过成片校验");
  assert.deepEqual(
    result.manifest.scenes.map((scene) => [scene.videoModel, scene.videoMode]),
    [["doubao-seedance-2-0-260128", "image-to-video"], ["minimax-h3", "text-to-video"]],
    "交付清单必须逐镜记录实际模型与输入形态",
  );
  const onDisk = JSON.parse(fs.readFileSync(scenario.paths.manifest, "utf8"));
  assert.deepEqual(onDisk.scenes, result.manifest.scenes, "落盘清单与返回清单的逐镜审计必须一致");
});

/** 说明：缺失审计字段的历史运行只能记为 null，不得伪造模型或输入形态（前端据此不展示标签）。*/
test("生成审计：未提供模型与形态的镜次记为 null 而不是猜测值", async () => {
  const scenario = await buildScenario({ preset: "social-square", speechDurationsSec: [0.8, 0.8], tag: "no-audit" });
  const result = await composeFinalVideo(composeOptions(scenario));
  assert.deepEqual(
    result.manifest.scenes.map((scene) => [scene.videoModel, scene.videoMode]),
    scenario.scenes.map(() => [null, null]),
  );
});

test("配音与配乐可从 file / data / HTTP 来源进入合成", async () => {
  const scenario = await buildScenario({ preset: "social-square", speechDurationsSec: [0.8, 0.8], tag: "source" });
  const server = await listen((request, response) => {
    const file = request.url === "/music.wav" ? scenario.musicPath : scenario.voicePath;
    response.writeHead(200, { "content-type": "audio/wav" });
    fs.createReadStream(file).pipe(response);
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const { cues, durationSec } = scenario.timeline;
  try {
    const variants = [
      { name: "file://", voice: pathToFileURL(scenario.voicePath).href, music: pathToFileURL(scenario.musicPath).href },
      { name: "data:", voice: dataUrl(scenario.voicePath, "audio/wav"), music: dataUrl(scenario.musicPath, "audio/wav") },
      { name: "http:", voice: `${base}/voice.wav`, music: `${base}/music.wav` },
    ];
    for (const variant of variants) {
      const result = await composeFinalVideo(composeOptions(scenario, {
        voice: { voiceUrl: variant.voice, cues, durationSec },
        music: { musicUrl: variant.music },
      }));
      assert.ok(result.validated, `${variant.name} 来源应通过成片校验`);
      assert.ok(fs.existsSync(scenario.paths.finalVideo), `${variant.name} 来源应提升最终成片`);
      assert.equal(probeFinal(scenario.paths.finalVideo).audio.codec_name, "aac");
    }
  } finally {
    server.close();
  }
});

test("中文渲染探针通过真字体并拒绝缺字形/缺字体", async () => {
  assert.notEqual(CHINESE_RENDER_PROBE, TOFU_RENDER_PROBE);
  const paths = artifactPaths("glyph-probe-1");
  const ratio = await verifyChineseSubtitleRendering({
    canvasPreset: "social-square",
    fontPath: FONT_PATH,
    workspace: paths.temp,
  });
  assert.ok(ratio > MEDIA_LIMITS.subtitlePixelDiffRatio, `中文探针像素差异 ${ratio} 应超过阈值`);
  await assert.rejects(
    verifyChineseSubtitleRendering({
      canvasPreset: "social-square",
      fontPath: path.join(outputRoot, "missing-font.ttf"),
      workspace: paths.temp,
    }),
    /字体/,
  );
  const filters = await assertSubtitleFilters("ffmpeg");
  assert.match(filters, /(?:^|\s)ass(?:\s|$)/mu);
  await assert.rejects(
    assertSubtitleFilters("ffmpeg", { execFile: async () => ({ stdout: "Filters:\n ... scale  V->V  Scale\n", stderr: "" }) }),
    /缺少 ass|缺少 subtitles/u,
  );
});

test("缺失视频/配音/配乐/字体/字幕滤镜时真实合成直接拒绝，不留下降级产物", async () => {
  const scenario = await buildScenario({ preset: "social-square", speechDurationsSec: [0.6, 0.6], tag: "reject" });
  const base = composeOptions(scenario);

  await assert.rejects(composeFinalVideo({ ...base, scenes: [{ index: 1, durationSec: 0.6 }] }), /动态片段|标准化/u);
  await assert.rejects(composeFinalVideo({ ...base, scenes: [] }), /至少需要一个/u);
  await assert.rejects(composeFinalVideo({ ...base, voice: { voicePath: scenario.voicePath, durationSec: scenario.timeline.durationSec } }), /字幕 cue|cue/u);
  await assert.rejects(composeFinalVideo({ ...base, music: {} }), /配乐/u);
  await assert.rejects(composeFinalVideo({ ...base, fontPath: path.join(outputRoot, "missing-font.ttf") }), /字体/u);
  await assert.rejects(composeFinalVideo({ ...base, paths: undefined }), /artifactPaths|产物目录/u);
  await assert.rejects(
    composeFinalVideo({ ...base, execFile: async () => ({ stdout: "Filters:\n ... subtitles  V->V  x\n", stderr: "" }) }),
    /缺少 ass/u,
  );
  assert.equal(fs.existsSync(scenario.paths.finalVideo), false, "拒绝路径不得产出 final.mp4");
  assert.equal(fs.existsSync(scenario.paths.manifest), false, "拒绝路径不得产出 manifest.json");
});
