/**
 * @file 中文字幕字体就绪校验。
 * @description 使用 fontkit 解析字体家族名并验证中文映射与可渲染矢量轮廓。
 */
import fs from "node:fs";
import path from "node:path";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import * as fontkit from "fontkit";

const execFileAsync = promisify(execFileCallback);

/** 用于真实字幕预检的最小中文覆盖样本。 */
export const CHINESE_GLYPH_PROBE = "中文字幕";

function openedFonts(opened) {
  if (Array.isArray(opened?.fonts)) return opened.fonts;
  return opened ? [opened] : [];
}

function glyphHasPath(font, codePoint) {
  if (!font?.hasGlyphForCodePoint?.(codePoint)) return false;
  const glyph = font.glyphForCodePoint(codePoint);
  if (!glyph || !Number.isInteger(glyph.id) || glyph.id <= 0) return false;
  const commands = glyph.path?.commands;
  if (Array.isArray(commands)) return commands.length > 0;
  const svg = glyph.path?.toSVG?.();
  return typeof svg === "string" && svg.trim().length > 0;
}

/**
 * 把受支持的字体别名或路径解析为确定的字体文件路径；无法确定时返回空字符串。
 *
 * @param {string} font 字体家族名、别名或字体文件路径。
 * @returns {string} 已知的绝对路径，或空字符串表示需要走系统字体查询。
 * @example configuredFontPath("Microsoft YaHei");
 */
export function configuredFontPath(font) {
  const value = String(font || "").trim();
  if (!value) return "";
  if (path.isAbsolute(value) || /[\\/]/u.test(value) || /\.(?:ttf|ttc|otf)$/iu.test(value)) return path.resolve(value);
  if (process.platform === "win32" && /^Microsoft YaHei(?: UI)?$/iu.test(value)) {
    return path.join(process.env.WINDIR || "C:\\Windows", "Fonts", "msyh.ttc");
  }
  return "";
}

/**
 * 通过系统字体查询把家族名解析为确定的字体文件；无法精确匹配时抛错，避免静默回退到缺字形的字体。
 *
 * @param {string} font 字体家族名或别名。
 * @param {{execFile?: Function, timeoutMs?: number}} [options] 可注入的进程边界。
 * @returns {Promise<string>} 已确认存在的字体文件绝对路径。
 * @throws {Error} 命中回退字体或查询失败时抛出。
 * @example await resolveFontFile("Noto Sans CJK SC");
 */
export async function resolveFontFile(font, options = {}) {
  const value = String(font || "").trim();
  if (!value) throw new Error("中文字幕字体不能为空");
  const known = configuredFontPath(value);
  if (known) return known;
  const execute = options.execFile || execFileAsync;
  let match;
  try {
    match = await execute("fc-match", ["-f", "%{family}\n%{file}", value], {
      encoding: "utf8", windowsHide: true, timeout: options.timeoutMs ?? 15_000, maxBuffer: 2 * 1024 * 1024,
    });
  } catch (error) {
    throw new Error("配置的中文字幕字体无法精确解析；请配置字体文件路径", { cause: error });
  }
  const [family = "", matchedPath = ""] = String(match?.stdout || "").trim().split(/\r?\n/u);
  const normalize = (input) => String(input || "").toLowerCase().replace(/[\s_-]+/gu, "").replace(/["']/gu, "");
  const expected = normalize(value);
  const actualFamilies = family.split(",").map(normalize);
  if (!expected || !actualFamilies.some((actual) => actual === expected) || !fs.existsSync(matchedPath)) {
    throw new Error("配置的中文字幕字体无法精确解析；请配置字体文件路径");
  }
  return matchedPath;
}

/**
 * 从字体文件的第一个 face 解析用于 libass 匹配的字体家族名。
 *
 * @param {string} fontPath 精确的 TTF、OTF 或 TTC 文件路径。
 * @returns {string} 家族名；无法解析时返回空字符串。
 * @example fontFamilyName("C:\\Windows\\Fonts\\msyh.ttc");
 */
export function fontFamilyName(fontPath) {
  try {
    const font = openedFonts(fontkit.openSync(fontPath))[0];
    return String(font?.familyName || "").trim();
  } catch {
    return "";
  }
}

/**
 * 使用 fontkit 确认完整字体文件可把预检中文样本映射为非空矢量 glyph。
 *
 * @param {string} fontPath 精确的 TTF、OTF 或 TTC 文件路径。
 * @param {string} [sample] 要求覆盖的中文样本。
 * @returns {boolean} 至少一个字体 face 完整覆盖且可渲染样本时为 true。
 * @example fontSupportsChinese("C:\\Windows\\Fonts\\msyh.ttc");
 */
export function fontSupportsChinese(fontPath, sample = CHINESE_GLYPH_PROBE) {
  try {
    const codePoints = [...sample].map((character) => character.codePointAt(0));
    if (codePoints.length === 0) return false;
    const opened = fontkit.openSync(fontPath);
    return openedFonts(opened).some((font) => codePoints.every((codePoint) => glyphHasPath(font, codePoint)));
  } catch {
    return false;
  }
}
