// M4 多语言（PRD FR-12 全球化）：全局语言提示词机制。
// 复用 MingStar 全局语言提示词语义（src/utils/language.ts）：语言作为全局约束注入每步 prompt；
// zh-CN 为空不污染（与 MingStar 「zh-CN instruction 为空不污染」规则一致）。
import { LANGUAGES } from "./schemas.js";

// 各语言的「输出语言」指令。zh-CN 故意留空 —— 不向 prompt 注入任何指令，避免污染确定性输出。
const INSTRUCTIONS = {
  "zh-TW": "输出使用繁体中文。",
  en: "Output in English.",
  ja: "出力は日本語で。",
  ko: "출력은 한국어로.",
  // zh-CN: 空，不污染
};

export function languageInstruction(lang) {
  return INSTRUCTIONS[lang] || "";
}

// 全局语言提示词：仅非 zh-CN 时追加语言指令；zh-CN 原样返回（不污染 prompt）。
// 注入点：脚本 / 分镜这类「文本生成」步骤；TTS 通过 language 参数传递（见 providers.js）；
// 图像 / 音乐为视觉 / 器乐生成、无语言学输出，其语言已由上游分镜文本承载，不再单独注入。
export function withGlobalLanguage(prompt, lang) {
  const ins = languageInstruction(lang);
  if (!ins) return prompt;
  return `${prompt}\n${ins}`;
}

export { LANGUAGES };
