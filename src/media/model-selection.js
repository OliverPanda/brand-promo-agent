/**
 * @file 真实交付模型选择器。
 * @description 从网关实时模型清单中确定视频、TTS 与配乐模型，并保留选择来源供审计。
 */

const EXACT_VIDEO_PRIORITY = ["minimax-h3", "7zhe-seedance", "seedance-2.0"];
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
 * @returns {string} 可用的 TTS 模型 ID。
 * @throws {Error} 无可用 TTS 模型时抛出。
 * @example
 * selectTtsModel(["speech-02-hd"]);
 */
export function selectTtsModel(audioModels = [], configured) {
  const selected = configured || "speech-02-hd";
  if (audioModels.includes(selected)) return selected;
  throw new Error(`TTS 模型不可用：${selected}`);
}

/**
 * 一次性解析真实交付使用的模型并返回审计对象。
 *
 * @param {{brief?: {videoModel?: string}, liveModels: {byType?: {video?: string[], audio?: string[]}, raw?: Array<{id?: string, type?: string}>}, ttsModel?: string, musicModel: string}} input 解析输入。
 * @returns {{videoModel: string, ttsModel: string, musicModel: string, source: "manual" | "automatic"}} 解析结果。
 * @throws {Error} 任一必需模型不可用时抛出。
 * @example
 * resolveDeliveryModels({ brief: {}, liveModels, musicModel: "mureka-v1" });
 */
export function resolveDeliveryModels({ brief = {}, liveModels, ttsModel, musicModel }) {
  const videoModels = liveModels?.byType?.video || [];
  const audioModels = liveModels?.byType?.audio || [];
  const videoModel = brief.videoModel
    ? validateSelectedVideoModel(brief.videoModel, videoModels)
    : selectVideoModel(videoModels);
  const resolvedTts = selectTtsModel(audioModels, ttsModel);
  if (!musicModel) throw new Error("未配置配乐模型 PROMO_MUSIC_MODEL");

  const raw = Array.isArray(liveModels?.raw) ? liveModels.raw : [];
  const catalogHasMusic = raw.some((item) =>
    String(item?.type || "").toLowerCase() === "music"
      || /(?:music|mureka|suno)/i.test(String(item?.id || ""))
  );
  if (catalogHasMusic && !raw.some((item) => item?.id === musicModel)) {
    throw new Error(`配乐模型不可用：${musicModel}`);
  }
  return {
    videoModel,
    ttsModel: resolvedTts,
    musicModel,
    source: brief.videoModel ? "manual" : "automatic",
  };
}
