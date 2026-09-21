import { test } from "node:test";
import assert from "node:assert/strict";

import {
  VIDEO_MODEL_PRIORITY,
  isOmniFallbackModel,
  isTtsModel,
  resolveDeliveryModels,
  selectTtsFallbackModel,
  selectTtsModel,
  selectVideoModel,
  validateSelectedVideoModel,
  videoModelCandidates,
} from "../src/media/model-selection.js";

test("selectVideoModel：精确模型按交付优先级选择", () => {
  assert.equal(selectVideoModel(["seedance-2.0", "7zhe-seedance", "minimax-h3"]), "minimax-h3");
  assert.equal(selectVideoModel(["seedance-2.0", "7zhe-seedance"]), "7zhe-seedance");
  assert.equal(selectVideoModel(["seedance-2.0"]), "seedance-2.0");
});

test("selectVideoModel：Seedance 2.0 兼容候选稳定选择正式版、fast、mini", () => {
  assert.equal(
    selectVideoModel(["doubao-seedance-2-0-mini-260615", "doubao-seedance-2-0-260128"]),
    "doubao-seedance-2-0-260128"
  );
  assert.equal(selectVideoModel(["x-seedance-2.0-mini", "x-seedance-2.0-fast"]), "x-seedance-2.0-fast");
  assert.throws(() => selectVideoModel([]), /没有可用的动态视频模型/);
});

test("validateSelectedVideoModel：手选模型必须存在于实时视频集合", () => {
  assert.equal(validateSelectedVideoModel("seedance-2.0", ["seedance-2.0"]), "seedance-2.0");
  assert.throws(
    () => validateSelectedVideoModel("fake-video", ["seedance-2.0"]),
    /所选动态视频模型不可用/
  );
});

test("selectTtsModel：默认优先 speech-02-hd，并支持显式配置", () => {
  assert.equal(selectTtsModel(["tiny-iceberg", "speech-02-hd"]), "speech-02-hd");
  assert.equal(selectTtsModel(["speech-02-hd", "tts-special"], "tts-special"), "tts-special");
  assert.throws(() => selectTtsModel(["speech-02-hd"], "missing-tts"), /TTS 模型不可用/);
});

test("resolveDeliveryModels：返回视频、TTS、配乐与来源审计", () => {
  assert.deepEqual(
    resolveDeliveryModels({
      brief: { videoModel: "7zhe-seedance" },
      liveModels: {
        byType: { video: ["minimax-h3", "7zhe-seedance"], audio: ["speech-02-hd", "mureka-song", "mureka-query"] },
        raw: [
          { id: "minimax-h3", type: "video" },
          { id: "7zhe-seedance", type: "video" },
          { id: "speech-02-hd", type: "tts" },
          { id: "mureka-song", type: "music" },
          { id: "mureka-query", type: "music" },
        ],
      },
      musicModel: "mureka-song",
    }),
    {
      videoModel: "7zhe-seedance",
      // 手选只决定「先试哪个」，其余实时候选仍按优先级作为整镜耗尽后的降级链。
      videoModelFallbacks: ["minimax-h3"],
      ttsModel: "speech-02-hd",
      ttsFallbackModel: null,
      musicModel: "mureka-song",
      source: "manual",
    }
  );
});

test("VIDEO_MODEL_PRIORITY / videoModelCandidates：交付优先级与降级候选同源且稳定", () => {
  assert.deepEqual([...VIDEO_MODEL_PRIORITY], ["minimax-h3", "7zhe-seedance", "seedance-2.0"]);
  assert.deepEqual(
    videoModelCandidates(["seedance-2.0", "7zhe-seedance", "minimax-h3"]),
    ["minimax-h3", "7zhe-seedance", "seedance-2.0"]
  );
  // 兼容 Seedance 2.0 的实时型号补在固定优先级之后，正式版优先于 fast / mini。
  assert.deepEqual(
    videoModelCandidates(["doubao-seedance-2-0-mini-260615", "minimax-h3", "doubao-seedance-2-0-260128"]),
    ["minimax-h3", "doubao-seedance-2-0-260128", "doubao-seedance-2-0-mini-260615"]
  );
  assert.deepEqual(videoModelCandidates([]), []);
});

test("resolveDeliveryModels：Brief 手选优先于 env，env 优先于自动模型", () => {
  const liveModels = {
    byType: { video: ["minimax-h3", "seedance-2.0"], audio: ["speech-02-hd", "mureka-song", "mureka-query"] },
    raw: [
      { id: "speech-02-hd", type: "tts" },
      { id: "mureka-song", type: "music" },
      { id: "mureka-query", type: "music" },
    ],
  };
  assert.equal(resolveDeliveryModels({ brief: {}, liveModels, configuredVideoModel: "seedance-2.0", musicModel: "mureka-song" }).videoModel, "seedance-2.0");
  assert.equal(resolveDeliveryModels({ brief: {}, liveModels, configuredVideoModel: "seedance-2.0", musicModel: "mureka-song" }).source, "configured");
  assert.equal(resolveDeliveryModels({ brief: { videoModel: "minimax-h3" }, liveModels, configuredVideoModel: "seedance-2.0", musicModel: "mureka-song" }).source, "manual");
  assert.throws(
    () => resolveDeliveryModels({ brief: {}, liveModels, configuredVideoModel: "missing-video", musicModel: "mureka-song" }),
    /配置的动态视频模型不可用/
  );
});

test("TTS 判定：combined audio 中的音乐模型不能充当 TTS", () => {
  const raw = [
    { id: "speech-02-hd", type: "tts" },
    { id: "mureka-v1", type: "music" },
    { id: "suno-v4", type: "audio" },
  ];
  assert.equal(isTtsModel("speech-02-hd", raw), true);
  assert.equal(isTtsModel("mureka-v1", raw), false);
  assert.equal(isTtsModel("suno-v4", raw), false);
  assert.throws(() => selectTtsModel(["speech-02-hd", "mureka-v1"], "mureka-v1", raw), /TTS 模型不可用/);
});

test("isOmniFallbackModel：只认实时清单内的非 realtime omni 型号", () => {
  const raw = [
    { id: "qwen3.5-omni-flash-2026-03-15", type: "llm" },
    { id: "qwen3-omni-flash-realtime", type: "llm" },
    { id: "deepseek-v4-flash", type: "llm" },
  ];
  assert.equal(isOmniFallbackModel("qwen3.5-omni-flash-2026-03-15", raw), true);
  assert.equal(isOmniFallbackModel("qwen3-omni-flash-realtime", raw), false, "realtime 变体实测不返回音频");
  assert.equal(isOmniFallbackModel("qwen3.5-omni-flash-2026-03-15", []), false, "不在实时清单不得启用");
  assert.equal(isOmniFallbackModel("deepseek-v4-flash", raw), false, "非 omni 型号不得充当备用语音");
});

test("selectTtsFallbackModel：显式配置优先，其次按 flash → plus → qwen3 优先级", () => {
  const raw = [
    { id: "qwen3.5-omni-flash-2026-03-15" },
    { id: "qwen3.5-omni-plus-2026-03-15" },
    { id: "qwen3-omni-flash" },
  ];
  assert.equal(selectTtsFallbackModel(raw, "qwen3.5-omni-plus-2026-03-15"), "qwen3.5-omni-plus-2026-03-15");
  assert.equal(selectTtsFallbackModel(raw, ""), "qwen3.5-omni-flash-2026-03-15");
  assert.equal(selectTtsFallbackModel([{ id: "qwen3-omni-flash" }], ""), "qwen3-omni-flash");
  assert.equal(selectTtsFallbackModel([{ id: "qwen3.5-omni-plus-2026-03-15" }], ""), "qwen3.5-omni-plus-2026-03-15");
});

test("selectTtsFallbackModel：显式配置不可用时回落自动候选并告警，无候选返回 null", () => {
  const raw = [{ id: "qwen3.5-omni-flash-2026-03-15" }, { id: "qwen3-omni-flash-realtime" }];
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (message) => warnings.push(String(message));
  try {
    assert.equal(selectTtsFallbackModel(raw, "qwen3-omni-flash-realtime"), "qwen3.5-omni-flash-2026-03-15");
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /realtime|自动候选/);
    assert.equal(selectTtsFallbackModel([], "qwen3.5-omni-flash-2026-03-15"), null, "清单无候选时明确返回 null");
  } finally {
    console.warn = originalWarn;
  }
});

test("resolveDeliveryModels：实时清单含 omni 时写入备用 TTS 模型", () => {
  const liveModels = {
    byType: { video: ["minimax-h3"], audio: ["speech-02-hd", "mureka-song", "mureka-query"] },
    raw: [
      { id: "minimax-h3", type: "video" },
      { id: "speech-02-hd", type: "tts" },
      { id: "qwen3.5-omni-flash-2026-03-15", type: "llm" },
      { id: "mureka-song", type: "music" },
      { id: "mureka-query", type: "music" },
    ],
  };
  const resolved = resolveDeliveryModels({ brief: {}, liveModels, musicModel: "mureka-song" });
  assert.equal(resolved.ttsModel, "speech-02-hd");
  assert.equal(resolved.ttsFallbackModel, "qwen3.5-omni-flash-2026-03-15");
});

test("resolveDeliveryModels：自动选择时把其余候选写入降级链，供整镜耗尽后换渠道", () => {
  const liveModels = {
    byType: { video: ["minimax-h3", "7zhe-seedance", "seedance-2.0", "doubao-seedance-2-0-260128"], audio: ["speech-02-hd", "mureka-song", "mureka-query"] },
    raw: [
      { id: "speech-02-hd", type: "tts" },
      { id: "mureka-song", type: "music" },
      { id: "mureka-query", type: "music" },
    ],
  };
  const resolved = resolveDeliveryModels({ brief: {}, liveModels, musicModel: "mureka-song" });
  assert.equal(resolved.videoModel, "minimax-h3");
  assert.deepEqual(
    resolved.videoModelFallbacks,
    ["7zhe-seedance", "seedance-2.0", "doubao-seedance-2-0-260128"],
    "降级链不含主模型，且保持既定优先级"
  );
  assert.equal(resolved.videoModelFallbacks.includes(resolved.videoModel), false);
});
