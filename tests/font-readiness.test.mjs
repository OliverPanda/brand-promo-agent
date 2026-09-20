import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

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

test("fontSupportsChinese：仅伪造 cmap 的截断文件必须拒绝", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "promo-font-ready-"));
  const font = path.join(dir, "fabricated-cmap.ttf");
  try {
    fs.writeFileSync(font, minimalFormat12Font(CHINESE_CODE_POINTS));
    assert.equal(fontSupportsChinese(font), false);
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

function firstExisting(candidates) {
  return candidates.find((candidate) => candidate && fs.existsSync(candidate));
}

function platformFixtures() {
  if (process.platform === "win32") {
    const fonts = path.join(process.env.WINDIR || "C:\\Windows", "Fonts");
    return {
      cjk: firstExisting([path.join(fonts, "msyh.ttc"), path.join(fonts, "simsun.ttc")]),
      latin: firstExisting([path.join(fonts, "arial.ttf"), path.join(fonts, "calibri.ttf")]),
    };
  }
  if (process.platform === "darwin") {
    return {
      cjk: firstExisting(["/System/Library/Fonts/PingFang.ttc", "/System/Library/Fonts/STHeiti Medium.ttc"]),
      latin: firstExisting(["/System/Library/Fonts/Helvetica.ttc", "/Library/Fonts/Arial.ttf"]),
    };
  }
  let cjk = "";
  try {
    cjk = execFileSync("fc-match", ["-f", "%{file}", ":lang=zh"], { encoding: "utf8" }).trim();
  } catch {}
  return {
    cjk: firstExisting([cjk, "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc"]),
    latin: firstExisting([
      "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
      "/usr/share/fonts/truetype/liberation2/LiberationSans-Regular.ttf",
    ]),
  };
}

test("fontSupportsChinese：可用真实 CJK 字体通过，真实 Latin-only 字体拒绝", (t) => {
  const fixtures = platformFixtures();
  if (!fixtures.cjk || !fixtures.latin) return t.skip("当前平台缺少可验证的 CJK/Latin 系统字体夹具");
  assert.equal(fontSupportsChinese(fixtures.cjk), true, `CJK 字体应通过：${fixtures.cjk}`);
  assert.equal(fontSupportsChinese(fixtures.latin), false, `Latin-only 字体应拒绝：${fixtures.latin}`);
});
