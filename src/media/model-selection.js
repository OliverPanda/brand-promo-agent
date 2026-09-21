/**
 * @file 真实交付模型选择器。
 * @description 从网关实时模型清单中确定视频、TTS 与配乐模型，并保留选择来源供审计。
 */

// 交付优先级：用户既定顺序 minimax-h3 → 7zhe-seedance → seedance-2.0。
// 说明：既是「默认选中哪个」的顺序，也是「整镜尝试耗尽后先降级到哪个」的顺序，两处必须同源，避免漂移。
export const VIDEO_MODEL_PRIORITY = Object.freeze(["minimax-h3", "7zhe-seedance", "seedance-2.0"]);
const EXACT_VIDEO_PRIORITY = VIDEO_MODEL_PRIORITY;

// Mureka 协议桥的模型名（由 mingstar-model-bridge 在 one-api custom channel 下注册）。
// 配乐 = 同一渠道上的两个模型：提交任务 + 按 taskId 轮询；网关无 OpenAI /audio/music 路由。
export const MUSIC_SUBMIT_MODEL = "mureka-song";
export const MUSIC_QUERY_MODEL = "mureka-query";
const SEEDANCE_20_RE = /seedance[-_.]?2[-_.]?0/i;

// 备用 TTS（Qwen-Omni 多模态流式语音）候选。网关把 omni 型号归入 llm 分类，因此只能在 raw 清单里按 ID 匹配，
// 不能改 AUDIO_RE：否则前端音频/文本模型下拉会整体错位。
export const TTS_FALLBACK_MODEL_DEFAULT = "qwen3.5-omni-flash-2026-03-15";
const OMNI_FALLBACK_PRIORITY = [
  TTS_FALLBACK_MODEL_DEFAULT,
  "qwen3.5-omni-plus-2026-03-15",
  "qwen3-omni-flash",
];
const OMNI_REALTIME_RE = /realtime/i;

/**
 * 按交付优先级列出实时清单中全部可用视频候选。
 *
 * 说明：返回值既用于「默认选中第一个」，也用于「整镜生成尝试耗尽后依次降级」；固定优先级模型
 * 排在最前，其余兼容 Seedance 2.0 的实时模型按正式版 → fast → mini 排序兜底。
 *
 * @param {string[]} videoModels 实时分类为 video 的模型 ID。
 * @returns {string[]} 去重后的候选模型 ID，按优先级从高到低。
 * @example
 * videoModelCandidates(["seedance-2.0", "minimax-h3"]);
 */
export function videoModelCandidates(videoModels = []) {
  const available = [...new Set(videoModels.filter((id) => typeof id === "string" && id))];
  const ordered = EXACT_VIDEO_PRIORITY.filter((id) => available.includes(id));
  const compatible = available.filter((id) => !ordered.includes(id) && SEEDANCE_20_RE.test(id));
  compatible.sort((a, b) => {
    const rank = (id) => (/mini/i.test(id) ? 2 : /fast/i.test(id) ? 1 : 0);
    return rank(a) - rank(b) || a.localeCompare(b, "en");
  });
  return [...ordered, ...compatible];
}

/**
 * 从实时视频模型 ID 中按固定优先级选择交付模型。
 *
 * @param {string[]} videoModels 实时分类为 video 的模型 ID。
 * @returns {string} 选中的视频模型 ID。
 * @throws {Error} 实时清单中没有兼容模型时抛出中文错误。
 * @example
 * selectVideoModel(["7zhe-seedance", "minimax-h3"]);
 */
export function selectVideoModel(videoModels = []) {
  const candidates = videoModelCandidates(videoModels);
  if (candidates[0]) return candidates[0];
  const available = [...new Set(videoModels.filter((id) => typeof id === "string" && id))];
  const summary = available.slice(0, 8).join("、") || "无";
  throw new Error(`没有可用的动态视频模型；期望 minimax-h3、7zhe-seedance、seedance-2.0 或兼容 Seedance 2.0，当前视频候选：${summary}`);
}

/**
 * 验证用户手选的视频模型确实存在于实时视频集合。
 *
 * @param {string} selected 用户手选模型 ID。
 * @param {string[]} videoModels 实时分类为 video 的模型 ID。
 * @returns {string} 经验证的模型 ID。
 * @throws {RangeError} 手选模型不存在或类别不兼容时抛出。
 * @example
 * validateSelectedVideoModel("seedance-2.0", ["seedance-2.0"]);
 */
export function validateSelectedVideoModel(selected, videoModels = []) {
  if (videoModels.includes(selected)) return selected;
  throw new RangeError(`所选动态视频模型不可用：${String(selected)}`);
}

/**
 * 从实时音频集合解析 TTS 模型；默认优先 speech-02-hd。
 *
 * @param {string[]} audioModels 实时分类为 audio 的模型 ID。
 * @param {string | undefined} configured 显式配置的 TTS 模型。
 * @param {Array<{id?: string, type?: string}>} raw 网关原始模型元数据。
 * @returns {string} 可用的 TTS 模型 ID。
 * @throws {Error} 无可用 TTS 模型时抛出。
 * @example
 * selectTtsModel(["speech-02-hd"]);
 */
export function selectTtsModel(audioModels = [], configured, raw = []) {
  const selected = configured || "speech-02-hd";
  if (audioModels.includes(selected) && isTtsModel(selected, raw)) return selected;
  throw new Error(`TTS 模型不可用：${selected}`);
}

const MUSIC_MODEL_RE = /(?:^|[-_.])(music|mureka|suno|udio)(?:$|[-_.])/i;
const TTS_MODEL_RE = /(?:^|[-_.])(tts|speech|voice)(?:$|[-_.])|elevenlabs|dictvoice|chatts|tiny[-_.]?iceberg|minimax[-_.]?audio|doubao[-_.]?tts|\bbark\b/i;

/**
 * 判断 combined audio 分类中的模型是否确实提供语音合成能力。
 *
 * @param {string} modelId 候选模型 ID。
 * @param {Array<{id?: string, type?: string}>} raw 网关原始模型元数据。
 * @returns {boolean} 明确为 TTS/speech/voice 且非音乐家族时为 true。
 * @example
 * isTtsModel("speech-02-hd", [{ id: "speech-02-hd", type: "tts" }]);
 */
export function isTtsModel(modelId, raw = []) {
  const id = String(modelId || "");
  const entry = raw.find((item) => item?.id === id);
  const type = String(entry?.type || "").toLowerCase();
  if (type === "music" || MUSIC_MODEL_RE.test(id)) return false;
  if (["tts", "speech", "voice", "text-to-speech"].includes(type)) return true;
  return TTS_MODEL_RE.test(id);
}

/**
 * 判断模型是否可用作 Qwen-Omni 流式语音备用通道。
 *
 * 说明：网关把 omni 型号归入 llm 分类，因此候选只按 ID 前缀匹配实时清单；realtime 变体实测不返回音频，必须排除。
 *
 * @param {string} modelId 候选模型 ID。
 * @param {Array<{id?: string}>} raw 网关原始模型元数据。
 * @returns {boolean} 存在于实时清单且为非 realtime 的 omni 语音模型时为 true。
 * @example isOmniFallbackModel("qwen3.5-omni-flash-2026-03-15", raw);
 */
export function isOmniFallbackModel(modelId, raw = []) {
  const id = String(modelId || "");
  if (!id || OMNI_REALTIME_RE.test(id) || !/omni/i.test(id)) return false;
  return raw.some((item) => item?.id === id);
}

/**
 * 解析 TTS 备用通道模型；显式配置优先，其次按候选顺序取第一个存在的非 realtime omni 模型。
 *
 * @param {Array<{id?: string}>} raw 网关原始模型元数据。
 * @param {string | undefined | null} configured 显式配置的备用模型（PROMO_TTS_FALLBACK_MODEL）。
 * @returns {string|null} 可用的备用模型 ID；无候选时为 null（表示不启用回退）。
 * @example selectTtsFallbackModel(raw, "");
 */
export function selectTtsFallbackModel(raw = [], configured = "") {
  const entries = Array.isArray(raw) ? raw : [];
  const explicit = String(configured || "").trim();
  if (explicit) {
    if (isOmniFallbackModel(explicit, entries)) return explicit;
    // 说明：备用通道是主通道之外的最佳努力，配置写错不应把整条 run 拦在预检；降级为自动候选并留告警便于排查。
    console.warn(`[model-selection] TTS 备用模型 ${explicit} 不在实时清单或为 realtime 变体，改用自动候选`);
  }
  for (const candidate of OMNI_FALLBACK_PRIORITY) {
    if (isOmniFallbackModel(candidate, entries)) return candidate;
  }
  return null;
}

/**
 * 一次性解析真实交付使用的模型并返回审计对象。
 *
 * @param {{brief?: {videoModel?: string}, liveModels: {byType?: {video?: string[], audio?: string[]}, raw?: Array<{id?: string, type?: string}>}, configuredVideoModel?: string, ttsModel?: string, ttsFallbackModel?: string, musicModel?: string}} input 解析输入；`musicModel` 缺省为 Mureka 桥提交模型，`ttsFallbackModel` 缺省自动解析。
 * @returns {{videoModel: string, videoModelFallbacks: string[], ttsModel: string, ttsFallbackModel: string|null, musicModel: string, source: "manual" | "configured" | "automatic"}} 解析结果；`videoModelFallbacks` 为整镜尝试耗尽后按序降级的候选（不含主模型）。
 * @throws {Error} 任一必需模型不可用时抛出。
 * @example
 * resolveDeliveryModels({ brief: {}, liveModels, musicModel: MUSIC_SUBMIT_MODEL });
 */
export function resolveDeliveryModels({ brief = {}, liveModels, configuredVideoModel, ttsModel, ttsFallbackModel, musicModel }) {
  const videoModels = liveModels?.byType?.video || [];
  const audioModels = liveModels?.byType?.audio || [];
  let videoModel;
  let source;
  if (brief.videoModel) {
    videoModel = validateSelectedVideoModel(brief.videoModel, videoModels);
    source = "manual";
  } else if (configuredVideoModel) {
    if (!videoModels.includes(configuredVideoModel)) {
      throw new Error(`配置的动态视频模型不可用：${configuredVideoModel}`);
    }
    videoModel = configuredVideoModel;
    source = "configured";
  } else {
    videoModel = selectVideoModel(videoModels);
    source = "automatic";
  }
  const raw = Array.isArray(liveModels?.raw) ? liveModels.raw : [];
  const resolvedTts = selectTtsModel(audioModels, ttsModel, raw);
  // 备用 TTS 通道是主通道之外的最佳努力：无候选时为 null（只走主通道），不会因为备用通道缺失而拦下预检。
  const resolvedTtsFallback = selectTtsFallbackModel(raw, ttsFallbackModel);
  // 配乐固定走 Mureka 协议桥：提交与轮询是两个模型，缺任一都会在付费后失败，故在预检一并拦下。
  const resolvedMusic = musicModel || MUSIC_SUBMIT_MODEL;
  if (resolvedMusic !== MUSIC_SUBMIT_MODEL) {
    throw new Error(`配乐模型不可用：${resolvedMusic}（Mureka 桥仅提供 ${MUSIC_SUBMIT_MODEL}）`);
  }
  const missingBridgeModels = [MUSIC_SUBMIT_MODEL, MUSIC_QUERY_MODEL].filter(
    (id) => !raw.some((item) => item?.id === id),
  );
  if (missingBridgeModels.length) {
    throw new Error(`配乐桥模型不可用：网关实时清单缺少 ${missingBridgeModels.join("、")}`);
  }
  // 降级链：手选/配置只改变「先试哪个」，不关闭降级——上游整段故障时仍按既定优先级换渠道，
  // 否则一次上游抖动就把整条 REAL run 打死。已付费失败任务由网关自动冲正，换模型不会重复计费。
  const videoModelFallbacks = videoModelCandidates(videoModels).filter((id) => id !== videoModel);
  return {
    videoModel,
    videoModelFallbacks,
    ttsModel: resolvedTts,
    ttsFallbackModel: resolvedTtsFallback,
    musicModel: resolvedMusic,
    source,
  };
}
