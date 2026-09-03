// models-gateway 纯函数分类测试：type 字段优先，缺省按关键词回退（video > audio > image > llm）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyModelId, classifyRemoteModels, demoVideoChoices } from "../src/models-gateway.js";

test("classifyModelId：type 字段优先", () => {
  assert.equal(classifyModelId("any-name", "videogeneration"), "video");
  assert.equal(classifyModelId("any-name", "llm"), "llm");
  assert.equal(classifyModelId("any-name", "tts"), "audio");
  assert.equal(classifyModelId("any-name", "music"), "audio");
  assert.equal(classifyModelId("any-name", "image"), "image");
  assert.equal(classifyModelId("kling-v1-6", "llm"), "llm", "显式 type=llm 应覆盖关键词（不以名称为准）");
});

test("classifyModelId：无 type 时按关键词分类", () => {
  // 视频
  for (const id of ["kling-v1-6", "doubao-seedance-1-0", "veo-3", "runway-gen4", "hunyuan-video-pro", "luma-dream-machine", "hailuo-02", "wan2.1-t2v", "sora-2", "cogvideox-flash"]) {
    assert.equal(classifyModelId(id), "video", `${id} 应归 video`);
  }
  // 音频
  for (const id of ["tiny-iceberg", "mureka-v1", "suno-v4", "doubao-tts-1", "elevenlabs-multilingual", "minimax-audio-1"]) {
    assert.equal(classifyModelId(id), "audio", `${id} 应归 audio`);
  }
  // 图像
  for (const id of ["doubao-seedream-4-0-250828", "flux-1-pro", "dall-e-3", "midjourney-v6", "stable-diffusion-xl", "wanx-v1", "gpt-image-1", "kolors-v1"]) {
    assert.equal(classifyModelId(id), "image", `${id} 应归 image`);
  }
  // 文本兜底
  for (const id of ["deepseek-v4-flash", "glm-5", "qwen3-max", "gpt-5", "claude-sonnet-4"]) {
    assert.equal(classifyModelId(id), "llm", `${id} 应兜底归 llm`);
  }
});

test("classifyRemoteModels：去重 + 保序 + 混合输入", () => {
  const byType = classifyRemoteModels([
    { id: "deepseek-v4-flash", type: "llm" },
    { id: "glm-5", type: "chat" },
    { id: "kling-v1-6", type: "video" },
    { id: "hunyuan-video-pro" },
    { id: "kling-v1-6", type: "video" }, // 重复应去重
    { id: "doubao-seedream-4-0-250828", type: "image" },
    { id: "tiny-iceberg", type: "tts" },
    { id: "" }, // 空 id 跳过
    null, // 异常条目跳过
  ]);
  assert.equal(byType.llm.length, 2);
  assert.equal(byType.video.length, 2, "kling + hunyuan-video（关键词）");
  assert.ok(byType.video.includes("kling-v1-6") && byType.video.includes("hunyuan-video-pro"));
  assert.deepEqual(byType.audio, ["tiny-iceberg"]);
  assert.deepEqual(byType.image, ["doubao-seedream-4-0-250828"]);
});

test("demoVideoChoices：非空占位（仅声明路由演示）", () => {
  const c = demoVideoChoices();
  assert.ok(Array.isArray(c) && c.length >= 1);
  assert.equal(new Set(c).size, c.length, "占位候选不应重复");
});
