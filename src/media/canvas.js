/**
 * @file 社交媒体成片画布预设。
 * @description 统一解析分辨率、画幅比例与字幕安全区，禁止调用方提交任意宽高。
 */

/** 默认社交媒体画布预设标识。 */
export const DEFAULT_CANVAS_PRESET = "social-portrait";

const freezePreset = (preset) => Object.freeze({
  ...preset,
  subtitle: Object.freeze({ ...preset.subtitle }),
});

/** 不可变的受控社交媒体画布注册表。 */
export const CANVAS_PRESETS = Object.freeze({
  "social-portrait": freezePreset({
    id: "social-portrait",
    width: 1080,
    height: 1920,
    aspectRatio: "9:16",
    subtitle: { fontSize: 52, marginV: 250, maxCharsPerLine: 16 },
  }),
  "social-landscape": freezePreset({
    id: "social-landscape",
    width: 1920,
    height: 1080,
    aspectRatio: "16:9",
    subtitle: { fontSize: 44, marginV: 96, maxCharsPerLine: 28 },
  }),
  "social-square": freezePreset({
    id: "social-square",
    width: 1080,
    height: 1080,
    aspectRatio: "1:1",
    subtitle: { fontSize: 46, marginV: 160, maxCharsPerLine: 20 },
  }),
});

/**
 * 解析受控画布预设；未指定时返回默认竖屏画布。
 *
 * @param {string | undefined} id 画布预设标识。
 * @returns {{id: string, width: number, height: number, aspectRatio: string, subtitle: {fontSize: number, marginV: number, maxCharsPerLine: number}}} 不可变画布配置。
 * @example
 * resolveCanvas("social-square");
 */
export function resolveCanvas(id = DEFAULT_CANVAS_PRESET) {
  const canvas = CANVAS_PRESETS[id];
  if (!canvas) throw new Error(`不支持的画布：${String(id)}`);
  return canvas;
}

/**
 * 生成供分镜与图像模型复用的画布构图约束。
 *
 * @param {{canvasPreset?: string} | undefined} brief 品牌简报。
 * @returns {string} 含尺寸、画幅与主体安全区要求的中文提示词。
 * @example
 * canvasPrompt({ canvasPreset: "social-portrait" });
 */
export function canvasPrompt(brief) {
  const canvas = resolveCanvas(brief?.canvasPreset);
  return `画布规格：${canvas.width}×${canvas.height}（${canvas.aspectRatio}）；构图要求：主体居中并完整置于安全区，四周预留裁切空间，避免关键内容贴边。`;
}
