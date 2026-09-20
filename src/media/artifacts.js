/**
 * @file 运行媒体工作区与产物生命周期。
 * @description 统一解析受控路径、原子写入/提升产物，并安全清理单次运行目录。
 */
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { pipeline } from "node:stream/promises";

/** 媒体下载、验收和时间轴使用的统一阈值。 */
export const MEDIA_LIMITS = {
  downloadTimeoutMs: 30_000,
  maxImageBytes: 25 * 1024 * 1024,
  maxVideoBytes: 500 * 1024 * 1024,
  maxAudioBytes: 50 * 1024 * 1024,
  minFinalVideoBytes: 10_000,
  durationToleranceSec: 0.75,
  subtitlePixelDiffRatio: 0.005,
  voiceGapMs: 120,
};

const RESERVED_RUN_IDS = new Set([...Object.getOwnPropertyNames(Object.prototype), "__proto__", "prototype"]);
const WINDOWS_DEVICE_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;
const trustedArtifactPaths = new WeakSet();

/**
 * 返回当前媒体输出根目录。
 * @returns {string} 绝对输出根目录。
 * @example outputRoot();
 */
export function outputRoot() {
  const dataDir = process.env.PROMO_DATA_DIR || path.resolve(process.cwd(), "data");
  const configured = path.resolve(process.env.PROMO_OUTPUT_ROOT || path.join(dataDir, "outputs"));
  return fs.existsSync(configured) ? fs.realpathSync(configured) : configured;
}

function isContained(root, target, allowRoot = false) {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  if (relative === "") return allowRoot;
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function validateRunId(runId) {
  if (typeof runId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(runId)
    || RESERVED_RUN_IDS.has(runId) || WINDOWS_DEVICE_NAME.test(runId)) throw new Error("非法 runId");
}

function rejectLink(target, label) {
  const stat = fs.lstatSync(target, { throwIfNoEntry: false });
  if (stat?.isSymbolicLink()) throw new Error(`${label} 不得是符号链接或目录联接`);
}

function assertTrustedPaths(paths) {
  if (!paths || !trustedArtifactPaths.has(paths)) throw new Error("必须使用 artifactPaths 返回的可信路径对象");
}

function verifyCanonicalPaths(paths) {
  assertTrustedPaths(paths);
  rejectLink(paths.runRoot, "runRoot");
  rejectLink(paths.workspace, "workspace");
  const realRoot = fs.realpathSync(paths.outputRoot);
  const realRunRoot = fs.realpathSync(paths.runRoot);
  const realWorkspace = fs.realpathSync(paths.workspace);
  if (!isContained(realRoot, realRunRoot) || !isContained(realRoot, realWorkspace)
    || realRunRoot !== paths.runRoot || realWorkspace !== paths.workspace) throw new Error("产物路径越界或已被替换");
  return { realRoot, realRunRoot, realWorkspace };
}

function resolveArtifactPaths(runId, createDirectories) {
  validateRunId(runId);
  const configuredRoot = outputRoot();
  fs.mkdirSync(configuredRoot, { recursive: true });
  const root = fs.realpathSync(configuredRoot);
  const runRoot = path.resolve(root, runId);
  if (!isContained(root, runRoot)) throw new Error("非法 runId：输出路径越界");
  rejectLink(runRoot, "runRoot");
  const workspace = path.resolve(runRoot, "workspace");
  rejectLink(workspace, "workspace");
  if (createDirectories) {
    fs.mkdirSync(runRoot, { recursive: true });
    rejectLink(runRoot, "runRoot");
    fs.mkdirSync(workspace, { recursive: true });
    rejectLink(workspace, "workspace");
    const realRunRoot = fs.realpathSync(runRoot);
    const realWorkspace = fs.realpathSync(workspace);
    if (!isContained(root, realRunRoot) || !isContained(root, realWorkspace)) throw new Error("运行产物目录越界");
  }
  const paths = {
    outputRoot: root,
    runRoot,
    workspace,
    inputs: path.resolve(workspace, "inputs"),
    scenes: path.resolve(workspace, "scenes"),
    audio: path.resolve(workspace, "audio"),
    temp: path.resolve(workspace, "temp"),
    finalVideo: path.resolve(runRoot, "final.mp4"),
    subtitles: path.resolve(runRoot, "subtitles.srt"),
    manifest: path.resolve(runRoot, "manifest.json"),
    poster: path.resolve(runRoot, "poster.jpg"),
    tempFinalVideo: path.resolve(workspace, "temp", "final.mp4"),
    tempSubtitles: path.resolve(workspace, "temp", "subtitles.srt"),
    tempManifest: path.resolve(workspace, "temp", "manifest.json"),
    tempPoster: path.resolve(workspace, "temp", "poster.jpg"),
  };
  for (const value of Object.values(paths)) {
    if (value !== root && !isContained(root, value)) throw new Error("产物路径越界");
  }
  if (createDirectories) for (const dir of [paths.inputs, paths.scenes, paths.audio, paths.temp]) fs.mkdirSync(dir, { recursive: true });
  const frozen = Object.freeze(paths);
  trustedArtifactPaths.add(frozen);
  return frozen;
}

/**
 * 解析并创建单次运行的受控媒体目录。
 * @param {string} runId 服务端生成的运行 ID。
 * @returns {{outputRoot: string, runRoot: string, workspace: string, inputs: string, scenes: string, audio: string, temp: string, finalVideo: string, subtitles: string, manifest: string, poster: string, tempFinalVideo: string, tempSubtitles: string, tempManifest: string, tempPoster: string}} 路径集合。
 * @throws {Error} runId 非法或路径逃逸时抛出。
 * @example artifactPaths("run-123");
 */
export function artifactPaths(runId) {
  return resolveArtifactPaths(runId, true);
}

/**
 * 将 manifest 以同目录临时文件加 rename 的方式原子写入。
 * @param {{manifest: string, runRoot: string}} paths `artifactPaths` 返回的路径集合。
 * @param {unknown} manifest 可 JSON 序列化的 manifest。
 * @returns {string} 最终 manifest 路径。
 * @example writeManifest(artifactPaths("run-123"), { runId: "run-123" });
 */
export function writeManifest(paths, manifest) {
  verifyCanonicalPaths(paths);
  const runRoot = path.resolve(paths?.runRoot || "");
  const target = path.resolve(paths?.manifest || "");
  if (!isContained(runRoot, target)) throw new Error("manifest 路径越界");
  fs.mkdirSync(runRoot, { recursive: true });
  const temporary = path.join(runRoot, `.manifest.${process.pid}.${randomUUID()}.tmp`);
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(manifest, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    fs.renameSync(temporary, target);
    return target;
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

/**
 * 将工作区内已完成的文件原子替换到公开产物位置。
 * @param {ReturnType<typeof artifactPaths>} paths `artifactPaths` 返回的路径集合。
 * @param {Partial<Record<"finalVideo"|"subtitles"|"manifest"|"poster", string>>} sources 产物键到工作区源文件的映射。
 * @param {{rename?: typeof fs.promises.rename}} [operations] 可注入的文件系统原子 rename 边界。
 * @returns {Promise<Record<string, string>>} 已提升的最终路径。
 * @example await promoteArtifacts(paths, { finalVideo: paths.tempFinalVideo });
 */
export async function promoteArtifacts(paths, sources, operations = {}) {
  const rename = operations.rename || fs.promises.rename;
  if (typeof rename !== "function") throw new Error("无效的产物提升操作");
  const { realWorkspace } = verifyCanonicalPaths(paths);
  const allowed = new Set(["finalVideo", "subtitles", "manifest", "poster"]);
  const entries = Object.entries(sources || {});
  if (entries.length === 0) throw new Error("没有待提升的产物");
  const validated = [];
  const opened = [];
  for (const [key, source] of entries) {
    if (!allowed.has(key) || typeof source !== "string") throw new Error(`未知产物：${key}`);
    const resolvedSource = path.resolve(source);
    const target = path.resolve(paths[key] || "");
    if (!isContained(paths.workspace, resolvedSource)) throw new Error(`产物源路径越界：${key}`);
    if (!isContained(paths.runRoot, target)) throw new Error(`产物目标路径越界：${key}`);
    let realSource;
    try {
      realSource = await fs.promises.realpath(resolvedSource);
    } catch {
      throw new Error(`产物不存在：${key}`);
    }
    if (!isContained(realWorkspace, realSource)) throw new Error(`产物源路径越界：${key}`);
    validated.push({ key, realSource, target });
  }

  const staged = [];
  const backups = [];
  const promoted = {};
  try {
    for (const { key, realSource, target } of validated) {
      const handle = await fs.promises.open(realSource, "r");
      opened.push({ handle });
      if (!(await handle.stat()).isFile()) throw new Error(`产物不存在：${key}`);
      const stage = path.join(paths.runRoot, `.${path.basename(target)}.${randomUUID()}.promoting`);
      staged.push({ key, stage, target });
      await pipeline(handle.createReadStream({ autoClose: false }), fs.createWriteStream(stage, { flags: "wx" }));
      await handle.close();
    }
    for (const item of staged) {
      if (await fs.promises.lstat(item.target).then(() => true, () => false)) {
        const backup = `${item.target}.${randomUUID()}.backup`;
        await rename(item.target, backup);
        backups.push({ target: item.target, backup });
      }
      await rename(item.stage, item.target);
      promoted[item.key] = item.target;
    }
    for (const { backup } of backups) {
      try {
        await fs.promises.rm(backup, { force: true });
      } catch (error) {
        console.warn(`[artifacts] 清理产物备份失败（${backup}）：`, error?.message || error);
      }
    }
    return promoted;
  } catch (error) {
    for (const target of Object.values(promoted)) await fs.promises.rm(target, { force: true });
    for (const { target, backup } of backups.reverse()) {
      if (await fs.promises.lstat(backup).then(() => true, () => false)) await rename(backup, target);
    }
    throw error;
  } finally {
    for (const { handle } of opened) await handle.close().catch(() => {});
    for (const { stage } of staged) await fs.promises.rm(stage, { force: true });
  }
}

/**
 * 删除单次运行的精确产物目录。
 * @param {string} runId 服务端运行 ID。
 * @returns {boolean} 调用前目标是否存在。
 * @example removeRunArtifacts("run-123");
 */
export function removeRunArtifacts(runId) {
  const paths = resolveArtifactPaths(runId, false);
  const root = path.resolve(paths.outputRoot);
  const target = path.resolve(paths.runRoot);
  if (!isContained(root, target)) throw new Error("拒绝删除输出根目录外的路径");
  const existed = fs.existsSync(target);
  fs.rmSync(target, { recursive: true, force: true });
  return existed;
}

/**
 * 生成适合 Content-Disposition 的安全中文下载名。
 * @param {string} label 品牌或产物显示名。
 * @param {string} runId 服务端运行 ID。
 * @param {string} extension 不含或包含前导点的扩展名。
 * @returns {string} 清理后的下载文件名。
 * @example safeDownloadName("铭星链 / Demo", "run-123", "mp4");
 */
export function safeDownloadName(label, runId, extension) {
  validateRunId(runId);
  const cleanPart = (value) => String(value || "").normalize("NFKC")
    .replace(/[^\p{L}\p{N}_-]+/gu, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
  const cleanLabel = cleanPart(label) || "media";
  const cleanExtension = String(extension || "").replace(/^\.+/, "").toLowerCase();
  if (!/^[a-z0-9]{1,10}$/.test(cleanExtension)) throw new Error("非法文件扩展名");
  return `${cleanLabel}-${runId}.${cleanExtension}`;
}
