import { test } from "node:test";
import assert from "node:assert/strict";
import {
  generateScript,
  generateStoryboard,
  generateSceneMedia,
  generateVoiceover,
  generateMusic,
  composite,
} from "../src/mastra/providers.js";

const brief = {
  brandName: "铭星科技",
  productName: "星链 Pro",
  coreSellingPoint: "一句话生成专业宣传片",
  audience: ["企业采购"],
  tones: ["科技感"],
  keyMessages: ["续航 30 小时"],
  durationSec: 30,
  language: "zh-CN",
  voiceTone: "男声",
};

test("generateScript 确定性且结构完整", async () => {
  const a = await generateScript(brief);
  const b = await generateScript(brief);
  assert.equal(a.title, b.title);
  assert.ok(Array.isArray(a.voiceover) && a.voiceover.length > 0);
  assert.deepEqual(a.structure, b.structure);
});

test("generateStoryboard 返回分镜数组", async () => {
  const script = await generateScript(brief);
  const scenes = await generateStoryboard(brief, script);
  assert.ok(Array.isArray(scenes) && scenes.length >= 3);
  assert.ok(scenes.every((s) => s.index && s.visualPrompt && s.camera));
});

test("generateSceneMedia 返回 SVG data URI", async () => {
  const script = await generateScript(brief);
  const scenes = await generateStoryboard(brief, script);
  const media = await generateSceneMedia(scenes[0], brief);
  assert.match(media.mediaUrl, /^data:image\/svg\+xml,/);
  assert.equal(media.kind, "image");
});

test("generateSceneMedia：logoColor 覆盖 DEMO 调色板主色（M4 模板库）", async () => {
  // DEMO 是默认路径，品牌主色须直接体现在占位图配色上（评审 F1 的 DEMO 半环）。
  const script = await generateScript(brief);
  const scenes = await generateStoryboard(brief, script);
  const media = await generateSceneMedia(scenes[0], { ...brief, logoColor: "#dc2626" });
  const svg = decodeURIComponent(media.mediaUrl.replace(/^data:image\/svg\+xml,/, ""));
  assert.match(svg, /#dc2626/i, "占位图应采用模板主色");
});

test("generateVoiceover 产出 SRT", async () => {
  const script = await generateScript(brief);
  const v = await generateVoiceover(script, brief);
  assert.ok(v.srt.includes("-->"));
  assert.equal(script.voiceover.length, 5);
  assert.equal(v.durationSec, 30);
  assert.deepEqual(v.sceneDurationsMs, [6000, 6000, 6000, 6000, 6000]);
  assert.match(v.srt, /00:00:24,000 --> 00:00:30,000/);
  assert.equal(v.sceneDurationsMs.reduce((sum, value) => sum + value, 0), 30_000);
});

test("generateMusic / composite 占位可跑通", async () => {
  const script = await generateScript(brief);
  const scenes = await generateStoryboard(brief, script);
  const m = await generateMusic(brief, scenes);
  assert.equal(m.model, "demo-mureka");
  const comp = await composite(scenes, { srt: "x" }, m, brief);
  assert.ok(Array.isArray(comp.storyboardGallery));
  assert.match(String(comp.note), /DEMO/);
});
