/**
 * @file 运行媒体工作区与产物生命周期。
 * @description 统一解析受控路径、原子写入/提升产物，并安全清理单次运行目录。
 */
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

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
const managedDirectories = new Map();

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

function registerManagedDirectory(directory, realRoot, realRunRoot) {
  rejectLink(directory, "受管媒体目录");
  const realDirectory = fs.realpathSync(directory);
  if (realDirectory !== path.resolve(directory)) throw new Error("受管媒体目录不得包含符号链接或目录联接");
  const stat = fs.statSync(realDirectory);
  if (!stat.isDirectory() || !isContained(realRoot, realDirectory) || !isContained(realRunRoot, realDirectory)) {
    throw new Error("受管媒体目录越界");
  }
  managedDirectories.set(realDirectory, { dev: stat.dev, ino: stat.ino, realRoot, realRunRoot });
  return realDirectory;
}

/**
 * 验证目录由 `artifactPaths` 创建且目录身份与真实边界未发生变化。
 * @param {string} directory 待验证的受管工作目录。
 * @returns {string} 通过验证的规范绝对路径。
 * @throws {Error} 目录未注册、被替换或逃逸时抛出。
 * @example validateManagedDirectory(artifactPaths("run-123").inputs);
 */
export function validateManagedDirectory(directory) {
  if (typeof directory !== "string" || directory.trim() === "") throw new Error("必须提供 artifactPaths 创建的受管工作区");
  const resolved = path.resolve(directory);
  rejectLink(resolved, "受管媒体目录");
  let realDirectory;
  try {
    realDirectory = fs.realpathSync(resolved);
  } catch {
    throw new Error("受管工作区不存在");
  }
  if (realDirectory !== resolved) throw new Error("受管工作区不得包含符号链接或目录联接");
  const record = managedDirectories.get(realDirectory);
  const stat = fs.statSync(realDirectory);
  if (!record || !stat.isDirectory() || stat.dev !== record.dev || stat.ino !== record.ino
    || !isContained(record.realRoot, realDirectory) || !isContained(record.realRunRoot, realDirectory)) {
    throw new Error("工作区不是 artifactPaths 创建的可信受管目录，或目录已被替换");
  }
  return realDirectory;
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
  if (createDirectories) {
    const realRunRoot = fs.realpathSync(runRoot);
    fs.mkdirSync(workspace, { recursive: true });
    registerManagedDirectory(workspace, root, realRunRoot);
    for (const dir of [paths.inputs, paths.scenes, paths.audio, paths.temp]) {
      rejectLink(dir, "受管媒体子目录");
      fs.mkdirSync(dir, { recursive: true });
      registerManagedDirectory(dir, root, realRunRoot);
    }
  }
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
 * 将受控运行目录内的既有产物解析为真实绝对路径（只读，不创建目录）。
 *
 * @param {string} runId 服务端生成的运行 ID。
 * @param {string} candidate 运行目录内的候选路径，或指向该文件的 file:// URL。
 * @returns {string} 位于该 run 目录内、非符号链接的真实文件绝对路径。
 * @throws {Error} runId 非法、文件不存在、越界或为链接时抛出。
 * @example resolveRunArtifact("run-123", "file:///.../scene-image.png");
 */
export function resolveRunArtifact(runId, candidate) {
  validateRunId(runId);
  if (typeof candidate !== "string" || candidate.trim() === "") throw new Error("产物路径不能为空");
  const configuredRoot = outputRoot();
  if (!fs.existsSync(configuredRoot)) throw new Error("运行产物根目录不存在");
  const root = fs.realpathSync(configuredRoot);
  const runRoot = path.resolve(root, runId);
  if (!isContained(root, runRoot)) throw new Error("非法 runId：产物路径越界");
  rejectLink(runRoot, "runRoot");
  const realRunRoot = fs.realpathSync(runRoot);
  if (realRunRoot !== runRoot) throw new Error("运行产物目录不得包含符号链接或目录联接");
  let resolved;
  try {
    resolved = candidate.startsWith("file:") ? fileURLToPath(new URL(candidate)) : path.resolve(candidate);
  } catch {
    throw new Error("产物路径无效");
  }
  if (!isContained(realRunRoot, resolved)) throw new Error("产物路径越界：不在本次运行目录内");
  rejectLink(resolved, "产物文件");
  const realTarget = fs.realpathSync(resolved);
  if (!isContained(realRunRoot, realTarget) || !fs.statSync(realTarget).isFile()) throw new Error("产物不存在或不是普通文件");
  return realTarget;
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
  for (const directory of managedDirectories.keys()) {
    if (isContained(target, directory)) managedDirectories.delete(directory);
  }
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
