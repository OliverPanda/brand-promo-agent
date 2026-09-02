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

test("generateVoiceover 产出 SRT", async () => {
  const script = await generateScript(brief);
  const v = await generateVoiceover(script, brief);
  assert.ok(v.srt.includes("-->"));
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
