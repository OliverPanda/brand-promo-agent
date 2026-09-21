/**
 * @file 真实交付模型选择器。
 * @description 从网关实时模型清单中确定视频、TTS 与配乐模型，并保留选择来源供审计。
 */

const EXACT_VIDEO_PRIORITY = ["minimax-h3", "7zhe-seedance", "seedance-2.0"];

// Mureka 协议桥的模型名（由 mingstar-model-bridge 在 one-api custom channel 下注册）。
// 配乐 = 同一渠道上的两个模型：提交任务 + 按 taskId 轮询；网关无 OpenAI /audio/music 路由。
export const MUSIC_SUBMIT_MODEL = "mureka-song";
export const MUSIC_QUERY_MODEL = "mureka-query";
const SEEDANCE_20_RE = /seedance[-_.]?2[-_.]?0/i;

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
  const available = [...new Set(videoModels.filter((id) => typeof id === "string" && id))];
  for (const exact of EXACT_VIDEO_PRIORITY) {
    if (available.includes(exact)) return exact;
  }
  const compatible = available.filter((id) => SEEDANCE_20_RE.test(id));
  compatible.sort((a, b) => {
    const rank = (id) => (/mini/i.test(id) ? 2 : /fast/i.test(id) ? 1 : 0);
    return rank(a) - rank(b) || a.localeCompare(b, "en");
  });
  if (compatible[0]) return compatible[0];
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
 * 一次性解析真实交付使用的模型并返回审计对象。
 *
 * @param {{brief?: {videoModel?: string}, liveModels: {byType?: {video?: string[], audio?: string[]}, raw?: Array<{id?: string, type?: string}>}, configuredVideoModel?: string, ttsModel?: string, musicModel?: string}} input 解析输入；`musicModel` 缺省为 Mureka 桥提交模型。
 * @returns {{videoModel: string, ttsModel: string, musicModel: string, source: "manual" | "configured" | "automatic"}} 解析结果。
 * @throws {Error} 任一必需模型不可用时抛出。
 * @example
 * resolveDeliveryModels({ brief: {}, liveModels, musicModel: MUSIC_SUBMIT_MODEL });
 */
export function resolveDeliveryModels({ brief = {}, liveModels, configuredVideoModel, ttsModel, musicModel }) {
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
  return {
    videoModel,
    ttsModel: resolvedTts,
    musicModel: resolvedMusic,
    source,
  };
}
