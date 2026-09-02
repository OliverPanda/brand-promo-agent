// Zod 校验 Schema：BrandBrief（对应 PRD §7）与各步输入/输出的轻量约束。
// 工作流步骤的 schema 刻意放宽（passthrough），避免 Mastra 严格校验阻断 DEMO 确定性数据。
import { z } from "zod";

export const LANGUAGES = ["zh-CN", "zh-TW", "en", "ja", "ko"];
export const DURATIONS = [15, 30, 60, 90];

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
});

export function parseBrief(input) {
  const r = BrandBriefSchema.safeParse(input || {});
  if (!r.success) {
    const msg = r.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; ");
    throw new Error(msg);
  }
  return r.data;
}
