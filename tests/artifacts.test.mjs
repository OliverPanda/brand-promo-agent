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

async function withDataDir(fn) {
  const previous = process.env.PROMO_DATA_DIR;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "promo-artifacts-"));
  process.env.PROMO_DATA_DIR = root;
  try {
    return await fn(root);
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

test("promoteArtifacts 成功时提升全部文件，失败时不留下部分最终产物", () => withDataDir(async () => {
  const ok = artifactPaths("promote-ok");
  const sources = {
    finalVideo: path.join(ok.temp, "render.mp4"),
    subtitles: path.join(ok.temp, "render.srt"),
    poster: path.join(ok.temp, "poster.jpg"),
  };
  fs.writeFileSync(sources.finalVideo, "video");
  fs.writeFileSync(sources.subtitles, "subtitle");
  fs.writeFileSync(sources.poster, "poster");
  await promoteArtifacts(ok, sources);
  assert.equal(fs.readFileSync(ok.finalVideo, "utf8"), "video");
  assert.equal(fs.readFileSync(ok.subtitles, "utf8"), "subtitle");
  assert.equal(fs.readFileSync(ok.poster, "utf8"), "poster");

  const bad = artifactPaths("promote-bad");
  const valid = path.join(bad.temp, "render.mp4");
  fs.writeFileSync(valid, "video");
  await assert.rejects(promoteArtifacts(bad, { finalVideo: valid, subtitles: path.join(bad.temp, "missing.srt") }), /不存在/);
  assert.equal(fs.existsSync(bad.finalVideo), false);
  assert.equal(fs.existsSync(bad.subtitles), false);
}));

test("promoteArtifacts 拒绝通过 workspace 内目录联接读取外部文件", (t) => withDataDir(async (dataDir) => {
  const paths = artifactPaths("promote-link");
  const outsideDir = path.join(dataDir, "outside-promotion");
  fs.mkdirSync(outsideDir);
  fs.writeFileSync(path.join(outsideDir, "external.mp4"), "external");
  const link = path.join(paths.temp, "linked-outside");
  try {
    fs.symlinkSync(outsideDir, link, process.platform === "win32" ? "junction" : "dir");
  } catch (error) {
    if (["EPERM", "EACCES"].includes(error.code)) {
      t.skip(`当前操作系统权限不允许创建目录联接：${error.code}`);
      return;
    }
    throw error;
  }
  await assert.rejects(
    promoteArtifacts(paths, { finalVideo: path.join(link, "external.mp4") }),
    /越界|工作区/,
  );
  assert.equal(fs.existsSync(paths.finalVideo), false);
}));

test("promoteArtifacts 部分提升失败后恢复既有产物且不留下新产物", () => withDataDir(async () => {
  const paths = artifactPaths("promote-rollback");
  fs.writeFileSync(paths.finalVideo, "old-video");
  fs.writeFileSync(paths.subtitles, "old-subtitles");
  const video = path.join(paths.temp, "new.mp4");
  const subtitles = path.join(paths.temp, "new.srt");
  fs.writeFileSync(video, "new-video");
  fs.writeFileSync(subtitles, "new-subtitles");
  let promotedCount = 0;
  const rename = async (source, target) => {
    if (source.endsWith(".promoting")) {
      promotedCount += 1;
      if (promotedCount === 2) throw new Error("injected second promotion failure");
    }
    await fs.promises.rename(source, target);
  };
  await assert.rejects(
    promoteArtifacts(paths, { finalVideo: video, subtitles }, { rename }),
    /injected second promotion failure/,
  );
  assert.equal(promotedCount, 2, "故障应发生在一个目标已经完成提升之后");
  assert.equal(fs.readFileSync(paths.finalVideo, "utf8"), "old-video");
  assert.equal(fs.readFileSync(paths.subtitles, "utf8"), "old-subtitles");
  assert.deepEqual(fs.readdirSync(paths.runRoot).filter((name) => /promoting|backup/.test(name)), []);
}));

test("artifactPaths 拒绝已存在的 run-root 目录联接逃逸", (t) => withDataDir((dataDir) => {
  const outputs = path.join(dataDir, "outputs");
  const outside = path.join(dataDir, "outside-run-root");
  fs.mkdirSync(outputs, { recursive: true });
  fs.mkdirSync(outside, { recursive: true });
  const linkedRun = path.join(outputs, "linked-run");
  try {
    fs.symlinkSync(outside, linkedRun, process.platform === "win32" ? "junction" : "dir");
  } catch (error) {
    if (["EPERM", "EACCES"].includes(error.code)) {
      t.skip(`当前操作系统权限不允许创建目录联接：${error.code}`);
      return;
    }
    throw error;
  }
  assert.throws(() => artifactPaths("linked-run"), /符号链接|联接|越界/);
  assert.deepEqual(fs.readdirSync(outside), []);
}));

for (const childName of ["inputs", "audio"]) {
  test(`artifactPaths 复用时拒绝 ${childName} 子目录联接逃逸`, (t) => withDataDir((dataDir) => {
    const paths = artifactPaths(`child-link-${childName}`);
    const outside = path.join(dataDir, `outside-${childName}`);
    fs.mkdirSync(outside);
    fs.rmSync(paths[childName], { recursive: true, force: true });
    try {
      fs.symlinkSync(outside, paths[childName], process.platform === "win32" ? "junction" : "dir");
    } catch (error) {
      if (["EPERM", "EACCES"].includes(error.code)) {
        t.skip(`当前操作系统权限不允许创建目录联接：${error.code}`);
        return;
      }
      throw error;
    }
    assert.throws(() => artifactPaths(`child-link-${childName}`), /符号链接|联接|越界/);
    assert.deepEqual(fs.readdirSync(outside), []);
  }));
}

test("产物写入与提升拒绝调用方伪造的路径对象", async () => withDataDir(async () => {
  const real = artifactPaths("trusted-run");
  const forged = { ...real, runRoot: path.dirname(real.runRoot), manifest: path.join(path.dirname(real.runRoot), "forged.json") };
  assert.throws(() => writeManifest(forged, { forged: true }), /可信|artifactPaths/);
  await assert.rejects(promoteArtifacts(forged, { finalVideo: real.tempFinalVideo }), /可信|artifactPaths/);
  assert.equal(Object.isFrozen(real), true);
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
