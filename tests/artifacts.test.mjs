/**
 * @file 媒体产物路径与生命周期测试。
 * @description 验证路径边界、原子提升、中文下载名和精确清理。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  MEDIA_LIMITS,
  artifactPaths,
  promoteArtifacts,
  removeRunArtifacts,
  safeDownloadName,
  writeManifest,
} from "../src/media/artifacts.js";

function withDataDir(fn) {
  const previous = process.env.PROMO_DATA_DIR;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "promo-artifacts-"));
  process.env.PROMO_DATA_DIR = root;
  try {
    return fn(root);
  } finally {
    if (previous === undefined) delete process.env.PROMO_DATA_DIR;
    else process.env.PROMO_DATA_DIR = previous;
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test("MEDIA_LIMITS 固定公开媒体安全阈值", () => {
  assert.deepEqual(MEDIA_LIMITS, {
    downloadTimeoutMs: 30_000,
    maxImageBytes: 25 * 1024 * 1024,
    maxVideoBytes: 500 * 1024 * 1024,
    maxAudioBytes: 50 * 1024 * 1024,
    minFinalVideoBytes: 10_000,
    durationToleranceSec: 0.75,
    subtitlePixelDiffRatio: 0.005,
    voiceGapMs: 120,
  });
});

test("artifactPaths 仅接受正常服务端 runId 且所有路径位于绝对输出边界内", () => withDataDir(() => {
  const paths = artifactPaths("run-123_A");
  for (const [key, value] of Object.entries(paths)) {
    if (key === "outputRoot") continue;
    assert.ok(path.isAbsolute(value), `${key} 应为绝对路径`);
    assert.ok(value.startsWith(`${paths.outputRoot}${path.sep}`), `${key} 应在输出根目录中`);
  }
  for (const id of ["../escape", "..", ".", "constructor", "toString", "__proto__", "a/b", "a\\b", "C:evil", "CON", " run"])
    assert.throws(() => artifactPaths(id), /非法 runId/);
}));

test("safeDownloadName 保留中文、字母、数字、连字符和下划线", () => {
  assert.equal(safeDownloadName("铭星链 / Demo", "run-123", "mp4"), "铭星链-Demo-run-123.mp4");
  assert.equal(safeDownloadName(" 品牌__A!? ", "run_1", ".srt"), "品牌__A-run_1.srt");
});

test("writeManifest 原子写入 manifest.json", () => withDataDir(() => {
  const paths = artifactPaths("manifest-run");
  const result = writeManifest(paths, { runId: "manifest-run", title: "中文" });
  assert.equal(result, paths.manifest);
  assert.deepEqual(JSON.parse(fs.readFileSync(paths.manifest, "utf8")), { runId: "manifest-run", title: "中文" });
  assert.deepEqual(fs.readdirSync(paths.runRoot).filter((name) => name.includes(".tmp")), []);
}));

test("promoteArtifacts 成功时提升全部文件，失败时不留下部分最终产物", () => withDataDir(() => {
  const ok = artifactPaths("promote-ok");
  const sources = {
    finalVideo: path.join(ok.temp, "render.mp4"),
    subtitles: path.join(ok.temp, "render.srt"),
    poster: path.join(ok.temp, "poster.jpg"),
  };
  fs.writeFileSync(sources.finalVideo, "video");
  fs.writeFileSync(sources.subtitles, "subtitle");
  fs.writeFileSync(sources.poster, "poster");
  promoteArtifacts(ok, sources);
  assert.equal(fs.readFileSync(ok.finalVideo, "utf8"), "video");
  assert.equal(fs.readFileSync(ok.subtitles, "utf8"), "subtitle");
  assert.equal(fs.readFileSync(ok.poster, "utf8"), "poster");

  const bad = artifactPaths("promote-bad");
  const valid = path.join(bad.temp, "render.mp4");
  fs.writeFileSync(valid, "video");
  assert.throws(() => promoteArtifacts(bad, { finalVideo: valid, subtitles: path.join(bad.temp, "missing.srt") }), /不存在/);
  assert.equal(fs.existsSync(bad.finalVideo), false);
  assert.equal(fs.existsSync(bad.subtitles), false);
}));

test("removeRunArtifacts 只删除精确 run 目录", () => withDataDir((dataDir) => {
  const old = artifactPaths("run-old");
  const sibling = artifactPaths("run-old-copy");
  fs.writeFileSync(old.finalVideo, "old");
  fs.writeFileSync(sibling.finalVideo, "keep");
  const outside = path.join(dataDir, "outside.txt");
  fs.writeFileSync(outside, "keep");
  removeRunArtifacts("run-old");
  assert.equal(fs.existsSync(old.runRoot), false);
  assert.equal(fs.existsSync(sibling.finalVideo), true);
  assert.equal(fs.existsSync(outside), true);
}));
