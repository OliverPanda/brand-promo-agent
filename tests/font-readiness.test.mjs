import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { fontSupportsChinese } from "../src/media/font-readiness.js";

const CHINESE_CODE_POINTS = [..."中文字幕"].map((char) => char.codePointAt(0));

function minimalFormat12Font(codePoints) {
  const groups = [...codePoints].sort((a, b) => a - b);
  const subtableLength = 16 + groups.length * 12;
  const cmapLength = 12 + subtableLength;
  const out = Buffer.alloc(28 + cmapLength);
  out.writeUInt32BE(0x00010000, 0);
  out.writeUInt16BE(1, 4);
  out.write("cmap", 12, 4, "ascii");
  out.writeUInt32BE(28, 20);
  out.writeUInt32BE(cmapLength, 24);
  out.writeUInt16BE(0, 28);
  out.writeUInt16BE(1, 30);
  out.writeUInt16BE(3, 32);
  out.writeUInt16BE(10, 34);
  out.writeUInt32BE(12, 36);
  const subtable = 40;
  out.writeUInt16BE(12, subtable);
  out.writeUInt32BE(subtableLength, subtable + 4);
  out.writeUInt32BE(groups.length, subtable + 12);
  groups.forEach((codePoint, index) => {
    const at = subtable + 16 + index * 12;
    out.writeUInt32BE(codePoint, at);
    out.writeUInt32BE(codePoint, at + 4);
    out.writeUInt32BE(index + 1, at + 8);
  });
  return out;
}

test("fontSupportsChinese：cmap 对全部中文样本有 glyph 时通过", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "promo-font-ready-"));
  const font = path.join(dir, "chinese.ttf");
  try {
    fs.writeFileSync(font, minimalFormat12Font(CHINESE_CODE_POINTS));
    assert.equal(fontSupportsChinese(font), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("fontSupportsChinese：存在字体文件但仅有拉丁 glyph 时拒绝", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "promo-font-missing-"));
  const font = path.join(dir, "latin-only.ttf");
  try {
    fs.writeFileSync(font, minimalFormat12Font([0x41, 0x42]));
    assert.equal(fontSupportsChinese(font), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("fontSupportsChinese：Windows 配置字体真实文件通过，fallback-only 字体拒绝", {
  skip: process.platform !== "win32",
}, () => {
  const fonts = path.join(process.env.WINDIR || "C:\\Windows", "Fonts");
  assert.equal(fontSupportsChinese(path.join(fonts, "msyh.ttc")), true, "微软雅黑应覆盖中文字幕样本");
  assert.equal(fontSupportsChinese(path.join(fonts, "arial.ttf")), false, "Arial 存在但不应被当作中文字体");
});
