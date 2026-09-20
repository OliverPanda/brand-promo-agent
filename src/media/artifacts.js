/**
 * @file 运行媒体工作区路径。
 * @description 为预检创建受控输出目录；完整素材生命周期由后续任务扩展。
 */
import fs from "node:fs";
import path from "node:path";

/**
 * 返回当前媒体输出根目录。
 *
 * @returns {string} 绝对输出根目录。
 * @example
 * outputRoot();
 */
export function outputRoot() {
  const dataDir = process.env.PROMO_DATA_DIR || path.resolve(process.cwd(), "data");
  return path.resolve(process.env.PROMO_OUTPUT_ROOT || path.join(dataDir, "outputs"));
}

function contained(root, target) {
  const relative = path.relative(root, target);
  return relative !== "" && !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative);
}

/**
 * 解析并创建单次运行的受控媒体目录。
 *
 * @param {string} runId 服务端生成的运行 ID。
 * @returns {{outputRoot: string, runRoot: string, workspace: string, inputs: string, scenes: string, audio: string, temp: string, finalVideo: string, subtitles: string, manifest: string, poster: string}} 路径集合。
 * @throws {Error} runId 非法或路径逃逸时抛出。
 * @example
 * artifactPaths("run-123");
 */
export function artifactPaths(runId) {
  if (typeof runId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(runId)) {
    throw new Error("非法 runId");
  }
  const root = outputRoot();
  const runRoot = path.resolve(root, runId);
  if (!contained(root, runRoot)) throw new Error("非法 runId：输出路径越界");
  const workspace = path.join(runRoot, "workspace");
  const paths = {
    outputRoot: root,
    runRoot,
    workspace,
    inputs: path.join(workspace, "inputs"),
    scenes: path.join(workspace, "scenes"),
    audio: path.join(workspace, "audio"),
    temp: path.join(workspace, "temp"),
    finalVideo: path.join(runRoot, "final.mp4"),
    subtitles: path.join(runRoot, "subtitles.srt"),
    manifest: path.join(runRoot, "manifest.json"),
    poster: path.join(runRoot, "poster.jpg"),
  };
  for (const dir of [root, runRoot, workspace, paths.inputs, paths.scenes, paths.audio, paths.temp]) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return paths;
}
