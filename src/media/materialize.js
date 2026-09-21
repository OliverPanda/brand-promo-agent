/**
 * @file 共享媒体物化器。
 * @description 将受信 data/http(s)/工作区文件输入流式落盘，并验证大小、MIME 与真实容器签名。
 */
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { MEDIA_LIMITS, validateManagedDirectory } from "./artifacts.js";

const KIND_LIMIT = { image: "maxImageBytes", video: "maxVideoBytes", audio: "maxAudioBytes" };
const MIME_PREFIX = { image: "image/", video: "video/", audio: "audio/" };
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const MAX_REDIRECTS = 5;
const RETRYABLE_HTTP_STATUSES = new Set([408, 425, 429]);
const RETRYABLE_NETWORK_CODES = new Set([
  "EAI_AGAIN", "ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "EPIPE", "EHOSTUNREACH", "ENETUNREACH", "ECONNABORTED",
]);
const MEDIA_DOWNLOAD_MAX_ATTEMPTS = 6;
const MEDIA_DOWNLOAD_DEFAULT_ATTEMPTS = 4;
const MEDIA_DOWNLOAD_DEFAULT_BACKOFF_MS = 1500;
const MEDIA_DOWNLOAD_DEFAULT_MAX_BACKOFF_MS = 15000;

/**
 * 解析 HTTP 媒体下载的最大尝试次数。
 *
 * 说明：成片地址由上游对象存储的签名 URL 提供，偶发抖动实测表现为 `fetch failed`（DNS/TLS/连接层），
 * 而重新下载是免费的；因此这里做有限重试，绝不把下载抖动放大成付费生成任务的重跑（见设计文档 §6.2 第 6 条）。
 *
 * @returns {number} 1~6 之间的尝试次数。
 * @example mediaDownloadAttemptCount(); // 4
 */
function mediaDownloadAttemptCount() {
  const raw = Number(process.env.PROMO_MEDIA_DOWNLOAD_ATTEMPTS ?? MEDIA_DOWNLOAD_DEFAULT_ATTEMPTS);
  if (!Number.isFinite(raw) || raw < 1) return 1;
  return Math.min(MEDIA_DOWNLOAD_MAX_ATTEMPTS, Math.floor(raw));
}

/**
 * 计算第 n 次下载失败后的等待毫秒数。
 *
 * 说明：退避必须是指数而非线性。2026-09-22 真实验收中视频任务已 SUCCESS，但下载成片时
 * 连续 fetch failed（ECONNREFUSED），线性 1500ms×3 的窗口只有约 4.5 秒，短暂断网跨过窗口后
 * 已付费的生成结果就被判失败；指数退避把默认窗口拉到约 22 秒，同时用封顶避免长时间空等失效 URL。
 *
 * @param {number} attempt 已失败的尝试序号（从 1 开始）。
 * @returns {number} 本次等待毫秒数。
 * @example mediaDownloadBackoffMs(1); // 1500
 */
function mediaDownloadBackoffMs(attempt) {
  const base = Number(process.env.PROMO_MEDIA_DOWNLOAD_BACKOFF_MS ?? MEDIA_DOWNLOAD_DEFAULT_BACKOFF_MS);
  const cap = Number(process.env.PROMO_MEDIA_DOWNLOAD_MAX_BACKOFF_MS ?? MEDIA_DOWNLOAD_DEFAULT_MAX_BACKOFF_MS);
  const safeBase = Number.isFinite(base) && base > 0 ? base : MEDIA_DOWNLOAD_DEFAULT_BACKOFF_MS;
  const safeCap = Number.isFinite(cap) && cap > 0 ? cap : MEDIA_DOWNLOAD_DEFAULT_MAX_BACKOFF_MS;
  return Math.min(safeCap, safeBase * 2 ** Math.max(0, attempt - 1));
}

// 提取错误链上的 cause 代码：Node fetch 只抛 TypeError("fetch failed")，真实原因（DNS/ECONNRESET/UND_ERR_*）
// 全在 error.cause 上，不带上就无法判断是网络抖动还是上游 URL 失效。
function errorCauseCode(error) {
  const seen = new Set();
  function walk(current, depth) {
    if (!current || typeof current !== "object" || depth > 5 || seen.has(current)) return "";
    seen.add(current);
    const code = current.code || current.errno;
    if (typeof code === "string" && code) return code;
    // 说明：Node undici 把连接层失败包成 AggregateError，真实 code 在 .errors[] 里；
    // 只看 .cause 会一路拿到空字符串，诊断就退化成无信息的 "fetch failed"。
    const nested = [];
    if (current.cause) nested.push(current.cause);
    if (Array.isArray(current.errors)) nested.push(...current.errors);
    for (const item of nested) {
      const hit = walk(item, depth + 1);
      if (hit) return hit;
    }
    return "";
  }
  return walk(error, 0);
}

/**
 * 把底层 cause 与目标主机拼进下载错误信息，保留原始 error 作为 cause。
 *
 * 说明：`fetch failed（ECONNREFUSED）` 单独看不出是哪个地址被拒。本机实测代理（Clash fake-IP）抖动时
 * 会瞬间拒绝连接，排障必须能区分「上游 URL 失效」与「本机出网被拒」，否则只能靠猜。
 *
 * @param {unknown} error 捕获到的错误。
 * @param {string} [host] 本次下载的目标主机；主机本身不可解析时留空。
 * @returns {Error} 带 cause 摘要与目标主机的错误。
 * @example describeDownloadFailure(new TypeError("fetch failed"), "cdn.example.com"); // 媒体下载失败：fetch failed（ECONNRESET） @ cdn.example.com
 */
function describeDownloadFailure(error, host) {
  const base = error instanceof Error ? error : new Error(String(error));
  const code = errorCauseCode(base);
  const suffix = host ? ` @ ${host}` : "";
  if (!code) return suffix && !base.message.includes(suffix) ? new Error(`${base.message}${suffix}`, { cause: base }) : base;
  if (base.message.includes(code) && (!suffix || base.message.includes(suffix))) return base;
  const message = base.message.includes(code) ? base.message : `${base.message}（${code}）`;
  return new Error(`${message}${suffix}`, { cause: base });
}

/**
 * 判断下载错误是否为可重试的瞬时故障。
 *
 * 说明：只有网络类故障与 408/425/429/5xx 才重试；4xx 契约类错误（404 签名过期、403 拒绝、MIME 不符）
 * 重发同样失败，重试只会拖长失败时间。
 *
 * @param {unknown} error 捕获到的错误。
 * @param {boolean} aborted 调用方是否主动中止（超时不应重试）。
 * @returns {boolean} 可重试时返回 true。
 * @example isRetryableDownloadError(new TypeError("fetch failed")); // true
 */
function isRetryableDownloadError(error, aborted) {
  if (aborted) return false;
  const status = Number(error?.status);
  if (Number.isFinite(status) && status > 0) return RETRYABLE_HTTP_STATUSES.has(status) || status >= 500;
  const code = errorCauseCode(error);
  if (code && /ENOTFOUND|ERR_INVALID_URL|ERR_UNESCAPED_CHARACTERS|EACCES|EPERM/i.test(code)) return false;
  if (code && RETRYABLE_NETWORK_CODES.has(code)) return true;
  return /fetch failed|ECONNRESET|ETIMEDOUT|EPIPE|EAI_AGAIN|socket hang up|network|aborted|terminated|premature close/i.test(String(error?.message || error || ""));
}

function contained(root, target) {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function verifyMime(mime, kind) {
  const normalized = String(mime || "").split(";", 1)[0].trim().toLowerCase();
  if (!normalized || !normalized.startsWith(MIME_PREFIX[kind])) throw new Error(`媒体 MIME 与 ${kind} 不匹配：${normalized || "missing"}`);
}

function detectMedia(bytes, kind) {
  if (kind === "image") {
    if (bytes.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))) return ".png";
    if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return ".jpg";
    if (["GIF87a", "GIF89a"].includes(bytes.subarray(0, 6).toString("ascii"))) return ".gif";
    if (bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP") return ".webp";
  }
  if (kind === "video") {
    if (bytes.subarray(4, 8).toString("ascii") === "ftyp") return ".mp4";
    if (bytes.subarray(0, 4).equals(Buffer.from("1a45dfa3", "hex"))) return ".webm";
  }
  if (kind === "audio") {
    if (bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WAVE") return ".wav";
    if (bytes.subarray(0, 3).toString("ascii") === "ID3" || (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0)) return ".mp3";
    if (bytes.subarray(0, 4).toString("ascii") === "OggS") return ".ogg";
    if (bytes.subarray(0, 4).toString("ascii") === "fLaC") return ".flac";
    if (bytes.subarray(4, 8).toString("ascii") === "ftyp") return ".m4a";
  }
  throw new Error(`${kind} 媒体格式或魔数无效`);
}

function limitingTransform(maxBytes) {
  let size = 0;
  return new Transform({
    transform(chunk, _encoding, callback) {
      size += chunk.length;
      if (size > maxBytes) callback(new Error(`媒体过大，超过 ${maxBytes} 字节上限`));
      else callback(null, chunk);
    },
  });
}

async function followHttp(source, signal, kind, maxBytes) {
  let current = new URL(source);
  const visited = new Set();
  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
    if (!new Set(["http:", "https:"]).has(current.protocol) || current.username || current.password) throw new Error("仅允许安全 HTTP(S) 地址或重定向");
    if (visited.has(current.href)) throw new Error("检测到循环重定向");
    visited.add(current.href);
    const response = await fetch(current, { redirect: "manual", signal });
    if (REDIRECT_STATUSES.has(response.status)) {
      if (redirects === MAX_REDIRECTS) {
        await response.body?.cancel();
        throw new Error("HTTP 重定向次数过多");
      }
      const location = response.headers.get("location");
      if (!location) {
        await response.body?.cancel();
        throw new Error("HTTP 重定向缺少 Location");
      }
      let next;
      try {
        next = new URL(location, current);
      } catch (error) {
        await response.body?.cancel();
        throw error;
      }
      if (!new Set(["http:", "https:"]).has(next.protocol)) {
        await response.body?.cancel();
        throw new Error("拒绝非 HTTP(S) 重定向");
      }
      if (current.protocol === "https:" && next.protocol === "http:") {
        await response.body?.cancel();
        throw new Error("拒绝 HTTPS 降级重定向");
      }
      await response.body?.cancel();
      current = next;
      continue;
    }
    if (!response.ok) {
      await response.body?.cancel();
      const failure = new Error(`媒体下载失败：HTTP ${response.status}`);
      failure.status = response.status;
      throw failure;
    }
    try {
      verifyMime(response.headers.get("content-type"), kind);
    } catch (error) {
      await response.body?.cancel();
      throw error;
    }
    const declared = Number(response.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > maxBytes) {
      await response.body?.cancel();
      throw new Error(`媒体过大，超过 ${maxBytes} 字节上限`);
    }
    if (!response.body) throw new Error("媒体响应为空");
    return Readable.fromWeb(response.body);
  }
  throw new Error("HTTP 重定向次数过多");
}

function dataSource(source, kind) {
  const comma = source.indexOf(",", 5);
  if (!source.startsWith("data:") || comma < 0) throw new Error("无效 data URL");
  const metadata = source.slice(5, comma).split(";");
  const mime = metadata.shift();
  verifyMime(mime, kind);
  if (!metadata.some((value) => value.toLowerCase() === "base64")) throw new Error("仅支持 base64 编码的媒体 data URL");
  const encoded = source.slice(comma + 1);
  if (encoded.length % 4 !== 0) throw new Error("无效 data URL 数据");
  const chunkChars = 64 * 1024;
  async function* decodeChunks() {
    for (let offset = 0; offset < encoded.length; offset += chunkChars) {
      const chunk = encoded.slice(offset, offset + chunkChars);
      const isLast = offset + chunkChars >= encoded.length;
      const pattern = isLast ? /^[A-Za-z0-9+/]*={0,2}$/ : /^[A-Za-z0-9+/]+$/;
      if (!pattern.test(chunk)) throw new Error("无效 data URL 数据");
      yield Buffer.from(chunk, "base64");
    }
  }
  return Readable.from(decodeChunks());
}

function fileSource(source, workspace) {
  let filename;
  if (source.startsWith("file:")) filename = fileURLToPath(new URL(source));
  else filename = path.isAbsolute(source) ? path.resolve(source) : path.resolve(workspace, source);
  if (!fs.statSync(filename, { throwIfNoEntry: false })?.isFile()) throw new Error("工作区媒体文件不存在");
  const realWorkspace = fs.realpathSync(workspace);
  const realFilename = fs.realpathSync(filename);
  if (!contained(realWorkspace, realFilename)) throw new Error("服务端文件路径越界，必须位于运行工作区内");
  return fs.createReadStream(realFilename);
}

/**
 * 将 data URL、HTTP(S) 或工作区内服务端文件物化为碰撞安全的本地媒体文件。
 * @param {{source: string, kind: "image"|"video"|"audio", workspace: string, downloadTimeoutMs?: number}} options 物化选项。
 * @returns {Promise<string>} 工作区内经魔数验证的绝对文件路径。
 * @throws {Error} 来源越界、超时、超限、MIME 或容器签名不匹配时抛出。
 * @example await materializeMedia({ source: imageUrl, kind: "image", workspace: paths.inputs });
 */
export async function materializeMedia({ source, kind, workspace, downloadTimeoutMs = MEDIA_LIMITS.downloadTimeoutMs }) {
  if (typeof source !== "string" || source.length === 0) throw new Error("媒体来源不能为空");
  if (!Object.hasOwn(KIND_LIMIT, kind)) throw new Error(`不支持的媒体类型：${kind}`);
  if (typeof workspace !== "string" || workspace.trim() === "") throw new Error("必须提供服务端创建的 workspace 工作区");
  const root = validateManagedDirectory(workspace);
  const maxBytes = MEDIA_LIMITS[KIND_LIMIT[kind]];
  const isHttp = /^https?:\/\//i.test(source);
  // 说明：重试在「每次尝试都重新建连 + 重新落盘」的粒度上进行，这样 body 读取中途断开也能整体重来；
  // 每次尝试使用独立临时文件与独立 AbortController，超时按单次尝试计算。
  const attempts = isHttp ? mediaDownloadAttemptCount() : 1;
  // 说明：主机只用于失败诊断；URL 本身是上游签名地址，不解析也不改写。
  let sourceHost = "";
  if (isHttp) { try { sourceHost = new URL(source).host; } catch { sourceHost = ""; } }

  for (let attempt = 1; ; attempt += 1) {
    const temporary = path.join(root, `.materialize.${randomUUID()}.tmp`);
    if (!contained(root, temporary)) throw new Error("物化目标路径越界");
    const controller = new AbortController();
    let timer;
    try {
      let input;
      if (source.startsWith("data:")) input = dataSource(source, kind);
      else if (isHttp) {
        timer = setTimeout(() => controller.abort(new Error("媒体下载超时")), downloadTimeoutMs);
        input = await followHttp(source, controller.signal, kind, maxBytes);
      } else if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(source) && !/^[A-Za-z]:[\\/]/.test(source) && !source.startsWith("file:")) {
        throw new Error("仅允许 data、HTTP(S) 或工作区内服务端文件");
      } else input = fileSource(source, root);

      await pipeline(input, limitingTransform(maxBytes), fs.createWriteStream(temporary, { flags: "wx" }), { signal: controller.signal });
      const stat = fs.statSync(temporary);
      if (stat.size === 0) throw new Error("媒体内容为空");
      const handle = fs.openSync(temporary, "r");
      const header = Buffer.alloc(Math.min(32, stat.size));
      try { fs.readSync(handle, header, 0, header.length, 0); } finally { fs.closeSync(handle); }
      const extension = detectMedia(header, kind);
      const target = path.join(root, `${kind}-${randomUUID()}${extension}`);
      if (!contained(root, target)) throw new Error("物化目标路径越界");
      fs.renameSync(temporary, target);
      return target;
    } catch (error) {
      const failure = controller.signal.aborted ? new Error("媒体下载超时", { cause: error }) : describeDownloadFailure(error, sourceHost);
      if (attempt >= attempts || !isRetryableDownloadError(error, controller.signal.aborted)) throw failure;
      const waitMs = mediaDownloadBackoffMs(attempt);
      console.warn(`[media] 下载第 ${attempt}/${attempts} 次失败（${failure.message}），${waitMs}ms 后对同一 URL 重试`);
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    } finally {
      if (timer) clearTimeout(timer);
      fs.rmSync(temporary, { force: true });
    }
  }
}
