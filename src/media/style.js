/**
 * @file 全片视觉风格预设。
 * @description 把「画风」收敛为受控枚举并解析为唯一风格锚点，供分镜、场景图与动态视频三段提示词共用。
 * 三段提示词只要不同源，模型就会逐镜改画风（首个分镜真人、后续动漫），因此风格锚点只允许有一个来源。
 */

/** 默认画面风格预设标识。 */
export const DEFAULT_STYLE_PRESET = "photoreal";

/** 自定义风格描述的字符上限，与 PRD §16.13 一致。 */
export const STYLE_DESCRIPTION_MAX = 200;

/** 每个预设共用的全片一致性硬约束，避免各预设各写一套措辞而漂移。 */
const CONSISTENCY_RULE = "全片所有镜头必须沿用同一画风、同一光影逻辑、同一材质与同一色板，不得逐镜切换画风。";

const freezePreset = (preset) => Object.freeze({ ...preset });

/** 不可变的受控画面风格注册表；key 即 Brief.stylePreset 的合法取值。 */
export const STYLE_PRESETS = Object.freeze({
  photoreal: freezePreset({
    id: "photoreal",
    label: "真人实拍",
    anchor: "画风：真人实拍级写实摄影，人物与场景均为真实拍摄质感；光影：自然光加柔和轮廓光，明暗过渡真实；材质：皮肤、织物、金属呈现真实质感与细微瑕疵；色彩：低饱和电影感调色，白平衡统一。",
  }),
  anime: freezePreset({
    id: "anime",
    label: "动漫",
    anchor: "画风：日式赛璐璐动画，均匀线稿配平涂色块，不出现真人面孔；光影：硬边阴影与高光，不做写实渐变；材质：色块化处理，无真实纹理与摄影噪点；色彩：高饱和二次元配色，全片共用一套色板。",
  }),
  "three-d": freezePreset({
    id: "three-d",
    label: "3D 渲染",
    anchor: "画风：三维渲染（PBR 材质），造型圆润，不出现二维线稿或真人照片；光影：三点布光加环境光遮蔽，反射与投影物理一致；材质：金属、玻璃、亚克力质感明确；色彩：统一的冷调或暖调主题色。",
  }),
  illustration: freezePreset({
    id: "illustration",
    label: "插画",
    anchor: "画风：现代扁平商业插画，几何化造型配手绘笔触；光影：简化为块面明暗，不使用写实光照；材质：纸张与笔刷肌理，无摄影噪点；色彩：有限色板的品牌色系，全片同源。",
  }),
  "ink-wash": freezePreset({
    id: "ink-wash",
    label: "国风水墨",
    anchor: "画风：中国水墨写意，以留白与晕染造型，不出现动漫或真人影像；光影：以墨色浓淡表现层次，不用强对比硬光；材质：宣纸纹理与飞白笔触；色彩：以墨色为主，辅以朱砂或石青点缀。",
  }),
  custom: freezePreset({
    id: "custom",
    label: "自定义",
    anchor: "画风与光影、材质、色彩：严格遵循用户给出的风格描述，不得自行改换或混搭其他画风。",
  }),
});

/**
 * 解析受控画面风格预设；未指定时返回默认真人实拍。
 *
 * @param {string | undefined} id 画面风格预设标识。
 * @returns {{id: string, label: string, anchor: string}} 不可变风格配置。
 * @throws {Error} 未知枚举值直接抛错，不做静默回落，避免提交的风格悄悄变成默认值。
 * @example
 * resolveStyle("anime").label; // "动漫"
 */
export function resolveStyle(id = DEFAULT_STYLE_PRESET) {
  if (!Object.hasOwn(STYLE_PRESETS, id)) throw new Error(`不支持的画面风格：${String(id)}`);
  return STYLE_PRESETS[id];
}

/**
 * 汇总交付回显用的风格记录，写入 manifest.json 的 style 段。
 *
 * @param {{stylePreset?: string, styleDescription?: string} | undefined} brief 品牌简报。
 * @returns {{preset: string, label: string, description: string}} 风格预设标识、中文标签与自定义描述（非自定义时为空串）。
 * @example
 * styleManifest({ stylePreset: "anime" }); // { preset: "anime", label: "动漫", description: "" }
 */
export function styleManifest(brief) {
  const style = resolveStyle(brief?.stylePreset);
  const description = style.id === "custom" ? String(brief?.styleDescription || "").trim() : "";
  return { preset: style.id, label: style.label, description };
}

/**
 * 生成全片共用的风格锚点：分镜、场景图与动态视频三段提示词必须注入同一份字符串。
 *
 * @param {{stylePreset?: string, styleDescription?: string} | undefined} brief 品牌简报。
 * @returns {string} 含画风、光影、材质、色彩与全片统一硬约束的中文风格锚点。
 * @throws {Error} 预设未知、或 custom 缺少风格描述时抛出。
 * @example
 * stylePrompt({ stylePreset: "custom", styleDescription: "黏土定格动画" });
 */
export function stylePrompt(brief) {
  const style = resolveStyle(brief?.stylePreset);
  if (style.id === "custom") {
    const description = String(brief?.styleDescription || "").trim();
    if (!description) throw new Error("画面风格为自定义时必须提供风格描述（styleDescription）");
    return `全片统一风格锚点：${style.anchor} 用户补充描述：${description}。${CONSISTENCY_RULE}`;
  }
  return `全片统一风格锚点：${style.anchor}${CONSISTENCY_RULE}`;
}
