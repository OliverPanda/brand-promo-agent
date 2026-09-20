/**
 * @file 中文字幕字体字形校验。
 * @description 使用 fontkit 打开完整字体并验证中文映射与可渲染矢量轮廓。
 */
import * as fontkit from "fontkit";

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
 * 使用 fontkit 确认完整字体文件可把预检中文样本映射为非空矢量 glyph。
 *
 * @param {string} fontPath 精确的 TTF、OTF 或 TTC 文件路径。
 * @param {string} [sample] 要求覆盖的中文样本。
 * @returns {boolean} 至少一个字体 face 完整覆盖且可渲染样本时为 true。
 * @example
 * fontSupportsChinese("C:\\Windows\\Fonts\\msyh.ttc");
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
