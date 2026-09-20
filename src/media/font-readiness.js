/**
 * @file 中文字幕字体字形校验。
 * @description 直接读取 OpenType cmap，避免把字体名称回退或仅存在的拉丁字体误判为可用。
 */
import fs from "node:fs";

/** 用于真实字幕预检的最小中文覆盖样本。 */
export const CHINESE_GLYPH_PROBE = "中文字幕";

function uint16(buffer, offset) {
  if (offset < 0 || offset + 2 > buffer.length) throw new RangeError("font table overflow");
  return buffer.readUInt16BE(offset);
}

function uint32(buffer, offset) {
  if (offset < 0 || offset + 4 > buffer.length) throw new RangeError("font table overflow");
  return buffer.readUInt32BE(offset);
}

function faceOffsets(buffer) {
  if (buffer.subarray(0, 4).toString("ascii") !== "ttcf") return [0];
  const count = uint32(buffer, 8);
  if (count < 1 || count > 64) throw new Error("invalid TTC face count");
  return Array.from({ length: count }, (_, index) => uint32(buffer, 12 + index * 4));
}

function cmapOffset(buffer, faceOffset) {
  const tableCount = uint16(buffer, faceOffset + 4);
  if (tableCount < 1 || tableCount > 4096) throw new Error("invalid OpenType table count");
  for (let index = 0; index < tableCount; index += 1) {
    const record = faceOffset + 12 + index * 16;
    if (buffer.subarray(record, record + 4).toString("ascii") === "cmap") return uint32(buffer, record + 8);
  }
  return -1;
}

function format12Glyph(buffer, offset, codePoint) {
  const length = uint32(buffer, offset + 4);
  const groupCount = uint32(buffer, offset + 12);
  const end = offset + length;
  if (length < 16 || end > buffer.length || groupCount > 1_000_000) return 0;
  let low = 0;
  let high = groupCount - 1;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const group = offset + 16 + middle * 12;
    if (group + 12 > end) return 0;
    const start = uint32(buffer, group);
    const finish = uint32(buffer, group + 4);
    if (codePoint < start) high = middle - 1;
    else if (codePoint > finish) low = middle + 1;
    else return (uint32(buffer, group + 8) + codePoint - start) >>> 0;
  }
  return 0;
}

function format4Glyph(buffer, offset, codePoint) {
  if (codePoint > 0xffff) return 0;
  const length = uint16(buffer, offset + 2);
  const end = offset + length;
  const segmentCount = uint16(buffer, offset + 6) / 2;
  if (length < 16 || end > buffer.length || !Number.isInteger(segmentCount) || segmentCount < 1) return 0;
  const endCodes = offset + 14;
  const startCodes = endCodes + segmentCount * 2 + 2;
  const deltas = startCodes + segmentCount * 2;
  const rangeOffsets = deltas + segmentCount * 2;
  for (let index = 0; index < segmentCount; index += 1) {
    const finish = uint16(buffer, endCodes + index * 2);
    if (codePoint > finish) continue;
    const start = uint16(buffer, startCodes + index * 2);
    if (codePoint < start) return 0;
    const delta = uint16(buffer, deltas + index * 2);
    const rangeWord = rangeOffsets + index * 2;
    const rangeOffset = uint16(buffer, rangeWord);
    if (rangeOffset === 0) return (codePoint + delta) & 0xffff;
    const glyphAddress = rangeWord + rangeOffset + (codePoint - start) * 2;
    if (glyphAddress + 2 > end) return 0;
    const glyph = uint16(buffer, glyphAddress);
    return glyph === 0 ? 0 : (glyph + delta) & 0xffff;
  }
  return 0;
}

function cmapSubtables(buffer, offset) {
  const count = uint16(buffer, offset + 2);
  if (count < 1 || count > 1024) return [];
  const tables = [];
  for (let index = 0; index < count; index += 1) {
    const record = offset + 4 + index * 8;
    const subtable = offset + uint32(buffer, record + 4);
    const format = uint16(buffer, subtable);
    if (format === 12 || format === 4) tables.push({ format, offset: subtable });
  }
  return tables.sort((a, b) => b.format - a.format);
}

function faceSupports(buffer, faceOffset, codePoints) {
  const cmap = cmapOffset(buffer, faceOffset);
  if (cmap < 0) return false;
  const tables = cmapSubtables(buffer, cmap);
  return codePoints.every((codePoint) => tables.some((table) => (
    table.format === 12
      ? format12Glyph(buffer, table.offset, codePoint)
      : format4Glyph(buffer, table.offset, codePoint)
  ) !== 0));
}

/**
 * 确认字体文件的 cmap 对预检中文样本均映射到真实 glyph。
 *
 * @param {string} fontPath 精确的 TTF、OTF 或 TTC 文件路径。
 * @param {string} [sample] 要求覆盖的中文样本。
 * @returns {boolean} 至少一个字体 face 完整覆盖样本时为 true。
 * @example
 * fontSupportsChinese("C:\\Windows\\Fonts\\msyh.ttc");
 */
export function fontSupportsChinese(fontPath, sample = CHINESE_GLYPH_PROBE) {
  try {
    const buffer = fs.readFileSync(fontPath);
    const codePoints = [...sample].map((char) => char.codePointAt(0));
    return codePoints.length > 0 && faceOffsets(buffer).some((faceOffset) => faceSupports(buffer, faceOffset, codePoints));
  } catch {
    return false;
  }
}
