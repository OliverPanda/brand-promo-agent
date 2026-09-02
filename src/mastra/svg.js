// SVG 辅助：将 SVG 字符串编码为可在 <img src> 中直接使用的 data URI。
export function encodeSVG(svg) {
  return "data:image/svg+xml," + encodeURIComponent(svg).replace(/'/g, "%27").replace(/"/g, "%22");
}
