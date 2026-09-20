// 真实 FFmpeg 合成冒烟测试（本机需有 ffmpeg 在 PATH，如 choco 版 8.0）。
// 直接驱动 providers.composite（不经 workflow 的 one-api 调用），验证 M4 以来未真机验证的两条合成路径：
//   A) 静态图序列 + 配音/配乐 → MP4（ffmpegAssemble：concat demuxer Duration 指令）
//   B) 全镜动态片段（mp4）→ concat 直拼 + 音频混流（ffmpegAssembleVideo）
// 若本机无 ffmpeg，自动 skip（不误报失败）。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";
import { composite } from "../src/mastra/providers.js";

function hasFfmpeg() {
  try {
    execFileSync("ffmpeg", ["-version"], { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}
const FF = hasFfmpeg();
// ffprobe 按 key 输出再解析：default 输出按字母序(format_name 在 duration 前)，且 format_name 自带逗号，只能按行+key 取
const probe = (file) => {
  const out = execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration,format_name", "-of", "default=noprint_wrappers=1", file], { stdio: "pipe" }).toString();
  const kv = Object.fromEntries(out.split("\n").filter(Boolean).map((l) => l.split("=", 2)));
  return { dur: kv.duration || "", fmt: kv.format_name || "" };
};

const prevMode = process.env.PROMO_PROVIDER_MODE;
const prevFfmpeg = process.env.PROMO_FFMPEG_BIN;

function svgDataUrl(i, color) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180"><rect width="320" height="180" fill="${color}"/><text x="160" y="96" fill="#fff" font-size="40" text-anchor="middle">镜 ${i}</text></svg>`;
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
}

// 真实 PNG dataURL：ffmpeg 此构建无 librsvg，SVG 素材会解码失败 → 用 lavfi 生成纯色 PNG 模拟真实场景图
function pngDataUrl(color, outFile) {
  execFileSync("ffmpeg", ["-y", "-f", "lavfi", "-i", `color=c=${color}:s=320x180`, "-frames:v", "1", outFile], { stdio: "pipe" });
  return `data:image/png;base64,${fs.readFileSync(outFile).toString("base64")}`;
}

function genSilentMp3(sec, out) {
  execFileSync("ffmpeg", ["-y", "-f", "lavfi", "-i", "anullsrc=r=44100:cl=mono", "-t", String(sec), "-b:a", "64k", out], { stdio: "pipe" });
  return `data:audio/mp3;base64,${fs.readFileSync(out).toString("base64")}`;
}

function genTestMp4(sec, color, out) {
  execFileSync("ffmpeg", ["-y", "-f", "lavfi", "-i", `color=c=${color}:s=320x180:d=${sec}:r=24`, "-c:v", "libx264", "-pix_fmt", "yuv420p", out], { stdio: "pipe" });
  return `file://${out}`;
}

const brief = { tones: ["科技感"] };
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "promo-test-"));
const voiceMp3 = path.join(tmp, "voice.mp3");
const musicMp3 = path.join(tmp, "music.mp3");

test("composite 真实合成 A：静态图序列 + 配音 + 配乐 → MP4（ffmpeg 可用时）", { skip: !FF && "本机无 ffmpeg，跳过真实合成" }, async () => {
  process.env.PROMO_PROVIDER_MODE = "real";
  process.env.PROMO_FFMPEG_BIN = "ffmpeg";
  const pngs = [1, 2, 3, 4].map((i) => path.join(tmp, `img${i}.png`));
  const scenes = [1, 2, 3, 4].map((i) => ({
    index: i,
    subtitle: `场景 ${i}`,
    mediaUrl: pngDataUrl(i % 2 ? "0x6366f1" : "0x0ea5e9", pngs[i - 1]),
    durationSec: 2,
  }));
  try {
    const voice = { voiceUrl: genSilentMp3(5, voiceMp3), srt: "1\n00:00:00,000 --> 00:00:02,000\n你好\n", voiceTone: "男声" };
    const music = { musicUrl: genSilentMp3(5, musicMp3), mood: "科技感" };
    const out = await composite(scenes, voice, music, brief);
    assert.equal(out.model, "ffmpeg", "real + ffmpeg 应走真实合成而非降级");
    assert.ok(out.videoUrl?.startsWith("file://"), `应产出 file:// MP4（实际 ${out.videoUrl}）`);
    const file = out.videoUrl.slice(7);
    assert.ok(fs.existsSync(file) && fs.statSync(file).size > 2000, "MP4 应存在且非空");
    const { dur, fmt } = probe(file);
    assert.match(fmt, /mp4|mov/, `格式应为 mp4（实际 ${fmt}）`);
    const total = scenes.reduce((a, s) => a + (s.durationSec || 0), 0);
    assert.ok(Math.abs(parseFloat(dur) - total) < 1.5, `时长应≈${total}s（实际 ${dur}s）`);
    assert.equal(out.storyboardGallery.length, 4);
    assert.ok(out.srt.includes("-->"));
  } finally {
    process.env.PROMO_PROVIDER_MODE = prevMode;
    process.env.PROMO_FFMPEG_BIN = prevFfmpeg;
  }
});

test("composite 真实合成 B：全镜动态片段 concat 直拼 + 配音 → MP4（ffmpeg 可用时）", { skip: !FF && "本机无 ffmpeg，跳过真实合成" }, async () => {
  process.env.PROMO_PROVIDER_MODE = "real";
  process.env.PROMO_FFMPEG_BIN = "ffmpeg";
  const v1 = path.join(tmp, "v1.mp4");
  const v2 = path.join(tmp, "v2.mp4");
  const scenes = [
    { index: 1, subtitle: "动态镜1", mediaUrl: svgDataUrl(1, "#7c3aed"), videoUrl: genTestMp4(2, "0x7c3aed", v1), durationSec: 2 },
    { index: 2, subtitle: "动态镜2", mediaUrl: svgDataUrl(2, "#dc2626"), videoUrl: genTestMp4(2, "0xdc2626", v2), durationSec: 2 },
  ];
  try {
    genSilentMp3(4, voiceMp3);
    const voice = { voicePath: voiceMp3, srt: "", voiceTone: "男声" };
    const out = await composite(scenes, voice, undefined, brief);
    assert.equal(out.model, "ffmpeg", "real + ffmpeg 应走真实合成");
    assert.ok(out.videoUrl?.startsWith("file://"), `应产出 file:// 视频（实际 ${out.videoUrl}）`);
    const file = out.videoUrl.slice(7);
    assert.ok(fs.existsSync(file) && fs.statSync(file).size > 2000, "拼接产物应存在且非空");
    const { dur, fmt } = probe(file);
    assert.match(fmt, /mp4|mov/);
    assert.ok(parseFloat(dur) >= 3.5, `两段 2s 片段拼接应≈4s（实际 ${dur}s）`);
    const audioStream = execFileSync("ffprobe", ["-v", "error", "-select_streams", "a:0", "-show_entries", "stream=codec_type", "-of", "csv=p=0", file], { stdio: "pipe" }).toString().trim();
    assert.equal(audioStream, "audio");
  } finally {
    process.env.PROMO_PROVIDER_MODE = prevMode;
    process.env.PROMO_FFMPEG_BIN = prevFfmpeg;
  }
});

test("composite 真实合成 C：动态片段 + 超长配乐 → 成片以画面总长截断（ffmpeg 可用时）", { skip: !FF && "本机无 ffmpeg，跳过真实合成" }, async () => {
  process.env.PROMO_PROVIDER_MODE = "real";
  process.env.PROMO_FFMPEG_BIN = "ffmpeg";
  const v1 = path.join(tmp, "c1.mp4");
  const scenes = [{ index: 1, subtitle: "动态镜1", mediaUrl: svgDataUrl(1, "#6366f1"), videoUrl: genTestMp4(2, "0x6366f1", v1), durationSec: 2 }];
  try {
    genSilentMp3(2, voiceMp3);
    genSilentMp3(20, musicMp3);
    const voice = { voiceUrl: pathToFileURL(voiceMp3).href, srt: "", voiceTone: "男声" };
    const music = { musicUrl: pathToFileURL(musicMp3).href, mood: "科技感" }; // 配乐 20s ≫ 画面 2s
    const out = await composite(scenes, voice, music, brief);
    assert.equal(out.model, "ffmpeg", "real + ffmpeg 应走真实合成");
    const file = out.videoUrl.slice(7);
    const { dur } = probe(file);
    assert.ok(Math.abs(parseFloat(dur) - 2) < 1.0, `配乐超长应截断到画面时长 2s（实际 ${dur}s）`);
  } finally {
    process.env.PROMO_PROVIDER_MODE = prevMode;
    process.env.PROMO_FFMPEG_BIN = prevFfmpeg;
  }
});
