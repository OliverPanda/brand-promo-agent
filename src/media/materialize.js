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
      throw new Error(`媒体下载失败：HTTP ${response.status}`);
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
  const temporary = path.join(root, `.materialize.${randomUUID()}.tmp`);
  if (!contained(root, temporary)) throw new Error("物化目标路径越界");

  const controller = new AbortController();
  let timer;
  try {
    let input;
    if (source.startsWith("data:")) input = dataSource(source, kind);
    else if (/^https?:\/\//i.test(source)) {
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
    if (controller.signal.aborted) throw new Error("媒体下载超时", { cause: error });
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
    fs.rmSync(temporary, { force: true });
  }
}
