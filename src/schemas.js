// Zod 校验 Schema：BrandBrief（对应 PRD §7）与各步输入/输出的轻量约束。
// 工作流步骤的 schema 刻意放宽（passthrough），避免 Mastra 严格校验阻断 DEMO 确定性数据。
import { z } from "zod";
import { CANVAS_PRESETS, DEFAULT_CANVAS_PRESET } from "./media/canvas.js";

export const LANGUAGES = ["zh-CN", "zh-TW", "en", "ja", "ko"];
export const DURATIONS = [15, 30, 60, 90];

// 品牌主色：仅接受 #RGB / #RRGGBB。
// M4 评审 F6：原为任意 ≤20 字符串，会直接进入 DEMO 的 SVG 填充属性，可破坏图形渲染。
export const LOGO_COLOR = z
  .string()
  .regex(/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/, "主色须为 #RGB 或 #RRGGBB 格式")
  .optional();

export const BrandBriefSchema = z.object({
  brandName: z.string().min(1, "品牌名必填").max(60),
  productName: z.string().min(1, "产品名必填").max(60),
  coreSellingPoint: z.string().min(1, "核心卖点必填").max(60, "卖点不超过 60 字"),
  audience: z.array(z.string()).default([]),
  tones: z.array(z.string()).default(["专业"]),
  keyMessages: z.array(z.string()).default([]),
  durationSec: z.union([z.literal(15), z.literal(30), z.literal(60), z.literal(90)]).default(30),
  styleReference: z.string().optional(),
  language: z.enum(LANGUAGES).default("zh-CN"),
  voiceTone: z.string().default("男声"),
  hitlEnabled: z.boolean().default(true),
  finalGateEnabled: z.boolean().default(true),
  canvasPreset: z.enum(Object.keys(CANVAS_PRESETS)).default(DEFAULT_CANVAS_PRESET),
  // M4 模板库：Logo 主色 / 禁用词（从品牌模板回灌，用于约束生成与配色统一）
  logoColor: LOGO_COLOR,
  bannedWords: z.array(z.string()).default([]),
  // 模型偏好：请求级覆盖（脚本/分镜用 LLM、场景图用图像模型）；不传则用服务端 env 默认。
  // 服务端在 /api/config.models 暴露 current/choices 供前端下拉选择。
  llmModel: z.string().max(80).optional(),
  imageModel: z.string().max(80).optional(),
  videoModel: z.string().max(80).optional(),
});

// 品牌模板（FR-1.3 / M4 模板库）：市场运营保存一套品牌预设，下次一键套用，保证调性统一。
export const BrandTemplateSchema = z.object({
  id: z.string().optional(),
  name: z.string().min(1, "模板名必填").max(40),
  brandName: z.string().max(60).optional(),
  productName: z.string().max(60).optional(),
  coreSellingPoint: z.string().max(60).optional(),
  logoColor: LOGO_COLOR,
  bannedWords: z.array(z.string()).default([]),
  defaultTone: z.string().default("专业"),
  defaultLanguage: z.enum(LANGUAGES).default("zh-CN"),
  industry: z.string().max(40).optional(),
  isPreset: z.boolean().default(false),
});

export function parseTemplate(input) {
  const r = BrandTemplateSchema.safeParse(input || {});
  if (!r.success) {
    const msg = r.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; ");
    throw new Error(msg);
  }
  return r.data;
}

export function parseBrief(input) {
  const r = BrandBriefSchema.safeParse(input || {});
  if (!r.success) {
    const msg = r.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; ");
    throw new Error(msg);
  }
  return r.data;
}
