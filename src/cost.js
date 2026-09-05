// 成本与预算（对应 PRD FR-10 / §15 决议）。
// 设计：单价表 + 用量 → 单步预估 cost；累计到 PromoRun.cost；超 PROMO_BUDGET_CAP 中止并提示。
// M2 仅做「预估 + 闸门 + 归集」，不接入四大阻断域真实计费/扣星钻（仅预留 cost 结构）。
//
// 真实单价参考 MingStar 现行通道（one-api 统一路由）：
//   - LLM（deepseek-v4-flash 等）：约 ¥4 / 1M tokens（含 cache），此处按 ¥0.004 / 1k 估算。
//   - 图像（Seedream doubao-seedream-4-0-250828）：¥0.20 / 张（参考图输入免费）。
//   - TTS / 音乐：按分钟 / 曲 估算占位价，后续接 ai-core 计费回写。

// 预算上限每次读取环境变量（元/次，默认 ¥20），便于不改代码即可调整；不缓存到模块加载期。
function readBudgetCap() {
  return Number(process.env.PROMO_BUDGET_CAP ?? 20);
}

// 动态视频单价（2026-09-04 自中转站 new-api 控制台 /api/pricing 实抓，非估算）：
//   站内汇率 usd_exchange_rate=7.3，default 分组倍率 1，quota_per_unit=500000。
//   - 按次计费（quota_type=1）：CNY/镜 = model_price × 7.3 → sora-2-pro $0.5/次 = ¥3.65；sora-2 $0.3/次 = ¥2.19
//   - 按量计费（quota_type=0，站内其余视频模型均为兜底倍率 37.5）：new-api 按上游回报 tokens 差额结算
//     （quota = tokens × ratio，500000 quota = $1），站内无固定每镜价 → 回落 PROMO_VIDEO_COST_FALLBACK（默认 ¥1/镜，
//     即原占位价）。若渠道日后配置了按次价，把「模型名: 单价」补进 VIDEO_PER_CALL_CNY 即可。
export const VIDEO_PER_CALL_CNY = { "sora-2-pro": 3.65, "sora-2": 2.19 };

export function videoCostPerScene(videoModel) {
  const hit = VIDEO_PER_CALL_CNY[String(videoModel || "").trim()];
  if (hit) return hit;
  const fb = Number(process.env.PROMO_VIDEO_COST_FALLBACK ?? 1.0);
  return Number.isFinite(fb) && fb >= 0 ? fb : 1.0;
}

// 单价表（CNY）。step 名与 workflow STEP / PromoRun.cost.step 对齐。
export const PRICING = {
  writeScript: { per1kTokens: 0.004 },
  storyboard: { per1kTokens: 0.004 },
  generateScenes: { perImage: 0.2, perVideo: 1.0 }, // 图按张；视频按镜——brief.videoModel 命中按次表用真实价，否则用回落价（见 videoCostPerScene）
  voiceover: { perMinute: 0.1 },
  music: { perTrack: 0.5 },
  composite: { perVideo: 1.0 },
};

// 依据用量估算单步 cost。usage 由真实 Provider 回传（tokens / images / minutes / tracks / videos + videoModel）。
// 返回 { step, tokens, amount }，amount 单位元（保留 4 位小数）。
export function costFor(step, usage = {}) {
  const p = PRICING[step];
  if (!p) return { step, tokens: usage.tokens ?? 0, amount: 0 };
  let amount = 0;
  if (p.per1kTokens) amount += ((usage.tokens ?? 0) / 1000) * p.per1kTokens;
  if (p.perImage) amount += (usage.images ?? 0) * p.perImage;
  if (p.perMinute) amount += (usage.minutes ?? 0) * p.perMinute;
  if (p.perTrack) amount += (usage.tracks ?? 0) * p.perTrack;
  if (p.perVideo) {
    const unit = usage.videoModel ? videoCostPerScene(usage.videoModel) : p.perVideo;
    amount += (usage.videos ?? 0) * unit;
  }
  return { step, tokens: usage.tokens ?? 0, amount: round4(amount) };
}

export function round4(n) {
  return Math.round((n + Number.EPSILON) * 10000) / 10000;
}

// 累计已归集成本。
export function sumCost(costs = []) {
  return round4((costs || []).reduce((a, c) => a + (c?.amount || 0), 0));
}

// 预算闸门：给定已归集列表 + 待加 stepCost + 上限，返回 { ok, total, cap, over }。
// ok=false 表示加入后将超限（应中止）。不改变调用方数据。
export function checkBudget(costs = [], stepCost = { amount: 0 }, cap = getBudgetCap()) {
  const c = cap ?? readBudgetCap();
  const total = round4(sumCost(costs) + (stepCost?.amount || 0));
  return { ok: total <= c, total, cap: c, over: round4(Math.max(0, total - c)) };
}

export function getBudgetCap() {
  return readBudgetCap();
}

// 预算超限错误：由 workflow 步骤抛出后，withStep 捕获并标记 run=failed（对应 FR-10.1 中止并提示）。
export class BudgetExceededError extends Error {
  constructor(message) {
    super(message);
    this.name = "BudgetExceededError";
    this.code = "BUDGET_EXCEEDED";
    this.retryable = false;
  }
}

// 人类可读的成本明细（用于交付页 / 日志）。
export function formatCostSummary(costs = []) {
  if (!costs?.length) return "无外部成本（DEMO 模式）";
  const lines = costs.map(
    (c) => `· ${c.step}: ¥${c.amount.toFixed(4)}${c.tokens ? ` (${c.tokens} tokens)` : ""}`
  );
  return [`本次预估总成本 ¥${sumCost(costs).toFixed(4)} / 上限 ¥${getBudgetCap()}`, ...lines].join("\n");
}
