import { test } from "node:test";
import assert from "node:assert/strict";

import {
  isTtsModel,
  resolveDeliveryModels,
  selectTtsModel,
  selectVideoModel,
  validateSelectedVideoModel,
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
    { videoModel: "7zhe-seedance", ttsModel: "speech-02-hd", musicModel: "mureka-song", source: "manual" }
  );
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
