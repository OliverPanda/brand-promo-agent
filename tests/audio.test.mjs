/**
 * @file 真实音频时间轴与字幕测试。
 * @description 覆盖 ffprobe、逐段拼接、Unicode 字幕拆分和受管素材物化。
 */
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

import { artifactPaths } from "../src/media/artifacts.js";
import { materializeMedia } from "../src/media/materialize.js";
import {
  buildVoiceTimeline,
  concatenateVoiceSegments,
  formatSrt,
  probeAudioDuration,
  wrapPcmAsWav,
} from "../src/media/audio.js";

const roots = [];
let runIndex = 0;

function workspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "promo-audio-"));
  roots.push(root);
  const previous = process.env.PROMO_DATA_DIR;
  process.env.PROMO_DATA_DIR = root;
  try {
    return artifactPaths(`audio-${runIndex += 1}`).audio;
  } finally {
    if (previous === undefined) delete process.env.PROMO_DATA_DIR;
    else process.env.PROMO_DATA_DIR = previous;
  }
}

function wavDataUrl(durationSec, frequency = 440) {
  const file = path.join(os.tmpdir(), `promo-tone-${process.pid}-${Date.now()}-${frequency}.wav`);
  execFileSync("ffmpeg", ["-y", "-f", "lavfi", "-i", `sine=frequency=${frequency}:duration=${durationSec}`, "-c:a", "pcm_s16le", file], { stdio: "pipe" });
  const value = `data:audio/wav;base64,${fs.readFileSync(file).toString("base64")}`;
  fs.rmSync(file, { force: true });
  return value;
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

test("buildVoiceTimeline 以实测时长加 120ms 间隔生成权威时间轴", () => {
  const out = buildVoiceTimeline(["第一句", "第二句"], [1.4, 2.1], { maxCharsPerLine: 16 });
  assert.deepEqual(out.sceneDurationsMs, [1520, 2100]);
  assert.equal(out.durationSec, 3.62);
  assert.deepEqual(out.cues.map(({ startMs, endMs }) => [startMs, endMs]), [[0, 1400], [1520, 3620]]);
});

test("Unicode 长中文最多两行且按码点数比例拆为连续子 cue，不截断原文", () => {
  const text = "你好😀，这是用于验证中文标点与表情符号不会被截断的长句子。";
  const out = buildVoiceTimeline([text], [3], { maxCharsPerLine: 5 });
  assert.ok(out.cues.length > 1);
  assert.ok(out.cues.every((cue) => cue.text.split("\n").length <= 2));
  assert.ok(out.cues.every((cue) => cue.text.split("\n").every((line) => [...line].length <= 5)));
  assert.equal(out.cues.map((cue) => cue.text.replaceAll("\n", "")).join(""), text);
  assert.equal(out.cues[0].startMs, 0);
  assert.equal(out.cues.at(-1).endMs, 3000);
  for (let i = 1; i < out.cues.length; i += 1) assert.equal(out.cues[i].startMs, out.cues[i - 1].endMs);
});

test("源文本多种空白先归一为单空格，任何 cue 仍最多两行", () => {
  const text = "  第一段\r\n\r\n第二段\t第三段　第四段   结尾  ";
  const normalized = "第一段 第二段 第三段 第四段 结尾";
  const out = buildVoiceTimeline([text], [2], { maxCharsPerLine: 4 });
  assert.ok(out.cues.every((cue) => cue.text.split("\n").length <= 2));
  assert.ok(out.cues.every((cue) => cue.text.split("\n").every((line) => [...line].length <= 4)));
  assert.equal(out.cues.map((cue) => cue.text.replaceAll("\n", "")).join(""), normalized);
});

test("极短语音按最大余数法重平衡，每个子 cue 至少 1ms 且精确耗尽片段", () => {
  const out = buildVoiceTimeline(["一二三四五六七八九十甲乙"], [0.004], { maxCharsPerLine: 2 });
  assert.equal(out.cues.length, 3);
  const cueDurations = out.cues.map((cue) => cue.endMs - cue.startMs);
  assert.ok(cueDurations.every((duration) => duration >= 1));
  assert.equal(cueDurations.reduce((sum, duration) => sum + duration, 0), 4);
  assert.equal(out.cues.at(-1).endMs, 4);
});

test("语音毫秒数小于所需字幕块数量时明确拒绝时间轴容量不足", () => {
  assert.throws(
    () => buildVoiceTimeline(["一二三四五六七八九十甲乙"], [0.002], { maxCharsPerLine: 2 }),
    /时间轴容量不足|毫秒.*字幕/,
  );
});

test("SRT 使用 UTF-8 标准逗号时间戳并移除非法控制字符", () => {
  const srt = formatSrt([
    { startMs: 0, endMs: 1400, text: "你\u0000好，世界！" },
    { startMs: 1520, endMs: 3620, text: "第二句" },
  ], 3.62);
  assert.equal(srt, "1\n00:00:00,000 --> 00:00:01,400\n你好，世界！\n\n2\n00:00:01,520 --> 00:00:03,620\n第二句\n");
});

test("拒绝空台词、非法时长、倒序/重叠 cue 和非法总时长", () => {
  assert.throws(() => buildVoiceTimeline([""], [1], { maxCharsPerLine: 10 }), /空|文本/);
  for (const duration of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, "1"]) {
    assert.throws(() => buildVoiceTimeline(["内容"], [duration], { maxCharsPerLine: 10 }), /时长/);
  }
  assert.throws(() => formatSrt([{ startMs: 10, endMs: 9, text: "坏" }], 1), /时间|倒序/);
  assert.throws(() => formatSrt([
    { startMs: 0, endMs: 800, text: "一" },
    { startMs: 700, endMs: 900, text: "二" },
  ], 1), /重叠|时间/);
  assert.throws(() => formatSrt([{ startMs: 0, endMs: 1, text: "一" }], -1), /时长/);
});

test("wrapPcmAsWav 补 44 字节 RIFF 头并写入正确采样规格", async () => {
  // 24000Hz / 单声道 / 16bit 各 0.25s = 12000 字节 = 6000 个采样帧。
  const pcm = Buffer.alloc(12000, 0x11);
  const wav = wrapPcmAsWav(pcm);
  assert.equal(wav.subarray(0, 4).toString("ascii"), "RIFF");
  assert.equal(wav.readUInt32LE(4), 36 + pcm.length);
  assert.equal(wav.subarray(8, 12).toString("ascii"), "WAVE");
  assert.equal(wav.subarray(12, 16).toString("ascii"), "fmt ");
  assert.equal(wav.readUInt32LE(16), 16, "fmt 块长度固定 16");
  assert.equal(wav.readUInt16LE(20), 1, "audioFormat=1 表示未压缩 PCM");
  assert.equal(wav.readUInt16LE(22), 1, "默认单声道");
  assert.equal(wav.readUInt32LE(24), 24000, "默认 24000Hz");
  assert.equal(wav.readUInt32LE(28), 48000, "byteRate = sampleRate * blockAlign");
  assert.equal(wav.readUInt16LE(32), 2, "blockAlign = channels * bitDepth/8");
  assert.equal(wav.readUInt16LE(34), 16, "默认 16bit");
  assert.equal(wav.subarray(36, 40).toString("ascii"), "data");
  assert.equal(wav.readUInt32LE(40), pcm.length);
  assert.equal(wav.length, 44 + pcm.length);
  assert.ok(wav.subarray(44).equals(pcm), "PCM 载荷必须原样保留");
  // 交给 ffprobe 必须被识别为真实可解码音频，而不是靠魔数糊过去。
  const wavWorkspace = workspace();
  const materialized = await materializeMedia({ source: `data:audio/wav;base64,${wav.toString("base64")}`, kind: "audio", workspace: wavWorkspace });
  assert.ok(materialized.endsWith(".wav"));
  const duration = await probeAudioDuration(materialized);
  assert.ok(Math.abs(duration - 0.25) < 0.02, `实际时长 ${duration}`);
});

test("wrapPcmAsWav 支持自定义规格并按整帧校验长度", () => {
  const stereo = wrapPcmAsWav(Buffer.alloc(640), { sampleRate: 48000, channels: 2, bitDepth: 16 });
  assert.equal(stereo.readUInt16LE(22), 2);
  assert.equal(stereo.readUInt32LE(24), 48000);
  assert.equal(stereo.readUInt32LE(28), 192000);
  assert.equal(stereo.readUInt16LE(32), 4);
});

test("wrapPcmAsWav 拒绝空数据、非法规格与非整帧长度", () => {
  assert.throws(() => wrapPcmAsWav(Buffer.alloc(0)), /空/);
  assert.throws(() => wrapPcmAsWav("not-buffer"), /Buffer|Uint8Array/);
  assert.throws(() => wrapPcmAsWav(Buffer.alloc(3)), /采样帧|整数倍/);
  assert.throws(() => wrapPcmAsWav(Buffer.alloc(2), { sampleRate: 0 }), /采样率/);
  assert.throws(() => wrapPcmAsWav(Buffer.alloc(2), { channels: -1 }), /声道/);
  assert.throws(() => wrapPcmAsWav(Buffer.alloc(2), { bitDepth: 12 }), /8 的整数倍/);
});

test("受管音频经 materialize、ffprobe 并按固定静音间隔拼接", async () => {
  const audioWorkspace = workspace();
  const first = await materializeMedia({ source: wavDataUrl(1.4, 440), kind: "audio", workspace: audioWorkspace });
  const second = await materializeMedia({ source: wavDataUrl(2.1, 660), kind: "audio", workspace: audioWorkspace });
  const durations = await Promise.all([probeAudioDuration(first), probeAudioDuration(second)]);
  assert.ok(Math.abs(durations[0] - 1.4) < 0.03);
  assert.ok(Math.abs(durations[1] - 2.1) < 0.03);
  const voicePath = await concatenateVoiceSegments([first, second], { workspace: audioWorkspace });
  assert.ok(voicePath.startsWith(`${path.resolve(audioWorkspace)}${path.sep}`));
  const total = await probeAudioDuration(voicePath);
  assert.ok(Math.abs(total - 3.62) < 0.06, `实际拼接时长 ${total}`);
});

test("ffprobe 失败与畸形 duration 都拒绝", async () => {
  await assert.rejects(
    probeAudioDuration("bad.wav", { execFile: async () => { throw new Error("boom"); } }),
    /ffprobe|探测/,
  );
  await assert.rejects(
    probeAudioDuration("bad.wav", { execFile: async () => ({ stdout: "N/A\n" }) }),
    /duration|时长/,
  );
});

test("拼接失败或最终探测失败会清理部分输出", async () => {
  const ffmpegWorkspace = workspace();
  const segment = path.join(ffmpegWorkspace, "segment.wav");
  fs.writeFileSync(segment, Buffer.from("segment"));
  await assert.rejects(
    concatenateVoiceSegments([segment], {
      workspace: ffmpegWorkspace,
      execFile: async (_command, args) => {
        fs.writeFileSync(args.at(-1), Buffer.from("partial"));
        throw new Error("ffmpeg failed");
      },
    }),
    /ffmpeg.*失败/,
  );
  assert.deepEqual(fs.readdirSync(ffmpegWorkspace).sort(), ["segment.wav"]);

  const probeWorkspace = workspace();
  const probeSegment = path.join(probeWorkspace, "segment.wav");
  fs.writeFileSync(probeSegment, Buffer.from("segment"));
  let call = 0;
  await assert.rejects(
    concatenateVoiceSegments([probeSegment], {
      workspace: probeWorkspace,
      execFile: async (_command, args) => {
        call += 1;
        if (call === 1) {
          fs.writeFileSync(args.at(-1), Buffer.from("partial"));
          return { stdout: "" };
        }
        return { stdout: "N/A\n" };
      },
    }),
    /duration|时长/,
  );
  assert.deepEqual(fs.readdirSync(probeWorkspace).sort(), ["segment.wav"]);
});

test("拼接与最终探测共用注入 execFile，并传递有界超时", async () => {
  const audioWorkspace = workspace();
  const segment = path.join(audioWorkspace, "segment.wav");
  fs.writeFileSync(segment, Buffer.from("segment"));
  const calls = [];
  const output = await concatenateVoiceSegments([segment], {
    workspace: audioWorkspace,
    processTimeoutMs: 4321,
    execFile: async (command, args, options) => {
      calls.push({ command, args, options });
      if (calls.length === 1) fs.writeFileSync(args.at(-1), Buffer.from("output"));
      return { stdout: calls.length === 2 ? "0.250\n" : "" };
    },
  });
  assert.ok(fs.existsSync(output));
  assert.equal(calls.length, 2);
  assert.deepEqual(calls.map((item) => item.command), ["ffmpeg", "ffprobe"]);
  assert.ok(calls.every((item) => item.options.timeout === 4321));
});

test("拼接进程超时会抛错并清理输出", async () => {
  const audioWorkspace = workspace();
  const segment = path.join(audioWorkspace, "segment.wav");
  fs.writeFileSync(segment, Buffer.from("segment"));
  let observedTimeout;
  await assert.rejects(
    concatenateVoiceSegments([segment], {
      workspace: audioWorkspace,
      processTimeoutMs: 25,
      execFile: async (_command, args, options) => {
        observedTimeout = options.timeout;
        fs.writeFileSync(args.at(-1), Buffer.from("partial"));
        const error = new Error("timed out");
        error.code = "ETIMEDOUT";
        throw error;
      },
    }),
    /ffmpeg.*失败|timed out/,
  );
  assert.equal(observedTimeout, 25);
  assert.deepEqual(fs.readdirSync(audioWorkspace).sort(), ["segment.wav"]);
});
