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

test("classifyModelId：视频子能力 API 回落真实归类（B 收紧，2026-09 实测清单）", () => {
  // 同族但非视频生成本体的子接口：image/tts/effects/lip-sync/control/识别/角色/检测 → 不得归 video
  const subApis = [
    "kling-image", "kling-image-2-1", "kling-multi-image2image", "kling-kolors-virtual-try-on",
    "kling-tts", "kling-text-to-audio", "kling-video-to-audio", "kling-voices-list",
    "kling-presets-xxx", "kling-lip-sync", "kling-advanced-lip-sync", "kling-effects",
    "kling-identify-face", "kling-meta-human", "kling-custom-train", "kling-video-motion-control",
    "kling-video-multi-prompt", "kling-video-extend", "runway-act_one", "runway-act_two", "runway-aleph",
    "wan2.2-animate-mix", "wan2.2-s2v-detect", "veo3.1-components", "veo3.1-fast-components",
    "veo3.1-fast-components-4K", "sora_image", "sora-characters",
    "pixverse-character",
  ];
  for (const id of subApis) {
    const cat = classifyModelId(id);
    assert.notEqual(cat, "video", `${id} 是子能力 API，不应归 video（实际 ${cat}）`);
    assert.ok(["audio", "image", "llm"].includes(cat), `${id} 应回落到真实类（实际 ${cat}）`);
  }
  // 真正的生成本体不受影响，仍归 video
  const coreApis = [
    "kling-video-v1-6", "kling-v2-6", "kling-v3", "kling-o1", "doubao-seedance-2-0-260128",
    "doubao-seedance-2-5-260628", "dreamina-seedance-2-0", "wan2.2-i2v-flash", "wan2.6-t2v",
    "hunyuan-video-pro", "veo3.1", "runway-generate", "runway-video2video", "sora-2", "hailuo-02",
    "pika-generate", "luma-video", "cogvideox-flash",
  ];
  for (const id of coreApis) {
    assert.equal(classifyModelId(id), "video", `${id} 是真生成本体，应归 video`);
  }
});

test("demoVideoChoices：非空占位（仅声明路由演示）", () => {
  const c = demoVideoChoices();
  assert.ok(Array.isArray(c) && c.length >= 1);
  assert.equal(new Set(c).size, c.length, "占位候选不应重复");
});
