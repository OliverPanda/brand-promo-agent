/**
 * @file 社交媒体素材归一化测试。
 * @description 用真实 FFmpeg/ffprobe 验证受管物化、安全边界、画布裁剪和视频时长补帧。
 */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { artifactPaths } from "../src/media/artifacts.js";
import { normalizeSceneImage, normalizeSceneVideo } from "../src/media/ffmpeg.js";
import { resolveCanvas } from "../src/media/canvas.js";

const originalOutputRoot = process.env.PROMO_OUTPUT_ROOT;
const root = fs.mkdtempSync(path.join(os.tmpdir(), "promo-normalize-"));
process.env.PROMO_OUTPUT_ROOT = root;

before(() => {
  execFileSync("ffmpeg", ["-version"], { stdio: "pipe" });
  execFileSync("ffprobe", ["-version"], { stdio: "pipe" });
});

after(() => {
  if (originalOutputRoot === undefined) delete process.env.PROMO_OUTPUT_ROOT;
  else process.env.PROMO_OUTPUT_ROOT = originalOutputRoot;
  fs.rmSync(root, { recursive: true, force: true });
});

function probe(file) {
  const stdout = execFileSync("ffprobe", [
    "-v", "error",
    "-select_streams", "v:0",
    "-show_entries", "stream=width,height,avg_frame_rate,sample_aspect_ratio,codec_name,pix_fmt:format=duration",
    "-of", "json",
    file,
  ], { stdio: "pipe" }).toString();
  const parsed = JSON.parse(stdout);
  return { ...parsed.streams[0], duration: Number(parsed.format.duration) };
}

function syntheticImage(target, size, color) {
  execFileSync("ffmpeg", ["-y", "-f", "lavfi", "-i", `color=c=${color}:s=${size}`, "-frames:v", "1", target], { stdio: "pipe" });
}

function syntheticVideo(target, { size, fps, duration, color }) {
  execFileSync("ffmpeg", [
    "-y", "-f", "lavfi", "-i", `color=c=${color}:s=${size}:r=${fps}:d=${duration}`,
    "-f", "lavfi", "-i", `sine=frequency=440:duration=${duration}`,
    "-shortest", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", target,
  ], { stdio: "pipe" });
}

for (const [preset, inputSize] of [
  ["social-portrait", "640x360"],
  ["social-landscape", "360x640"],
  ["social-square", "640x360"],
]) {
  test(`图片归一化为 ${preset} 精确画布`, async () => {
    const paths = artifactPaths(`normalize-image-${preset}`);
    const source = path.join(paths.inputs, "source.png");
    syntheticImage(source, inputSize, "0x336699");

    const output = await normalizeSceneImage({
      source,
      inputsWorkspace: paths.inputs,
      scenesWorkspace: paths.scenes,
      canvasPreset: preset,
    });

    const canvas = resolveCanvas(preset);
    const actual = probe(output);
    assert.equal(actual.width, canvas.width);
    assert.equal(actual.height, canvas.height);
    assert.equal(actual.sample_aspect_ratio, "1:1");
    assert.equal(path.dirname(output), paths.scenes);
    assert.match(output, /\.png$/u);
  });
}

for (const [preset, input] of [
  ["social-portrait", { size: "640x360", fps: 12, duration: 0.4, color: "red" }],
  ["social-landscape", { size: "360x640", fps: 50, duration: 1.6, color: "green" }],
  ["social-square", { size: "640x360", fps: 15, duration: 0.8, color: "blue" }],
]) {
  test(`视频归一化为 ${preset}、25fps、H.264 且按权威时长补齐/裁切`, async () => {
    const paths = artifactPaths(`normalize-video-${preset}`);
    const source = path.join(paths.inputs, "source.mp4");
    syntheticVideo(source, input);
    const durationSec = preset === "social-portrait" ? 1.2 : 0.8;

    const output = await normalizeSceneVideo({
      source,
      inputsWorkspace: paths.inputs,
      scenesWorkspace: paths.scenes,
      canvasPreset: preset,
      durationSec,
    });

    const canvas = resolveCanvas(preset);
    const actual = probe(output);
    assert.equal(actual.width, canvas.width);
    assert.equal(actual.height, canvas.height);
    assert.equal(actual.avg_frame_rate, "25/1");
    assert.equal(actual.sample_aspect_ratio, "1:1");
    assert.equal(actual.codec_name, "h264");
    assert.equal(actual.pix_fmt, "yuv420p");
    assert.ok(Math.abs(actual.duration - durationSec) < 0.001, `${actual.duration} 应等于 ${durationSec}`);
    const streams = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-show_entries", "stream=codec_type", "-of", "json", output], { stdio: "pipe" }).toString()).streams;
    assert.deepEqual(streams.map((stream) => stream.codec_type), ["video"], "归一化视频不得继承音频");
  });
}

function listen(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

test("归一化入口沿用 materializeMedia 的重定向、体积、MIME、魔数与工作区边界", async () => {
  const paths = artifactPaths("normalize-security");
  const outside = path.join(root, "outside.png");
  syntheticImage(outside, "16x16", "white");
  const server = await listen((req, res) => {
    if (req.url === "/redirect") {
      res.statusCode = 302;
      res.setHeader("location", pathToFileURL(outside).href);
      res.end();
      return;
    }
    if (req.url === "/large-image") {
      res.setHeader("content-type", "image/png");
      res.setHeader("content-length", String(25 * 1024 * 1024 + 1));
      res.end();
      return;
    }
    if (req.url === "/large-video") {
      res.setHeader("content-type", "video/mp4");
      res.setHeader("content-length", String(500 * 1024 * 1024 + 1));
      res.end();
      return;
    }
    if (req.url === "/wrong-mime") {
      res.setHeader("content-type", "text/plain");
      res.end("not an image");
      return;
    }
    res.setHeader("content-type", "image/png");
    res.end("not png bytes");
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const imageOptions = { inputsWorkspace: paths.inputs, scenesWorkspace: paths.scenes, canvasPreset: "social-square" };
  try {
    await assert.rejects(normalizeSceneImage({ ...imageOptions, source: `${base}/redirect` }), /重定向|HTTP/);
    await assert.rejects(normalizeSceneImage({ ...imageOptions, source: `${base}/large-image` }), /过大|上限/);
    await assert.rejects(normalizeSceneVideo({ ...imageOptions, source: `${base}/large-video`, durationSec: 1 }), /过大|上限/);
    await assert.rejects(normalizeSceneImage({ ...imageOptions, source: `${base}/wrong-mime` }), /MIME/);
    await assert.rejects(normalizeSceneImage({ ...imageOptions, source: `${base}/wrong-magic` }), /格式|魔数/);
    await assert.rejects(normalizeSceneImage({ ...imageOptions, source: outside }), /工作区|越界/);
  } finally {
    server.close();
  }
});
