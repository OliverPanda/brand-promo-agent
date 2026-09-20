import { test } from "node:test";
import assert from "node:assert/strict";

import {
  CANVAS_PRESETS,
  DEFAULT_CANVAS_PRESET,
  canvasPrompt,
  resolveCanvas,
} from "../src/media/canvas.js";
import { parseBrief } from "../src/schemas.js";

const REQUIRED_BRIEF = {
  brandName: "铭星科技",
  productName: "星链 Pro",
  coreSellingPoint: "一句话生成专业宣传片",
};

test("画布注册表包含三个不可变社交媒体预设", () => {
  assert.equal(DEFAULT_CANVAS_PRESET, "social-portrait");
  assert.deepEqual(resolveCanvas(), {
    id: "social-portrait",
    width: 1080,
    height: 1920,
    aspectRatio: "9:16",
    subtitle: { fontSize: 52, marginV: 250, maxCharsPerLine: 16 },
  });
  assert.deepEqual(resolveCanvas("social-landscape"), {
    id: "social-landscape",
    width: 1920,
    height: 1080,
    aspectRatio: "16:9",
    subtitle: { fontSize: 44, marginV: 96, maxCharsPerLine: 28 },
  });
  assert.deepEqual(resolveCanvas("social-square"), {
    id: "social-square",
    width: 1080,
    height: 1080,
    aspectRatio: "1:1",
    subtitle: { fontSize: 46, marginV: 160, maxCharsPerLine: 20 },
  });
  assert.equal(Object.isFrozen(CANVAS_PRESETS), true);
  assert.equal(Object.isFrozen(resolveCanvas().subtitle), true);
});

test("resolveCanvas 拒绝任意尺寸和值", () => {
  assert.throws(() => resolveCanvas("4096x4096"), /不支持的画布/);
  assert.throws(() => resolveCanvas({ width: 1080, height: 1920 }), /不支持的画布/);
});

test("canvasPrompt 明确画幅、像素尺寸和居中主体安全构图", () => {
  const prompt = canvasPrompt({ canvasPreset: "social-square" });
  assert.match(prompt, /1080×1080/);
  assert.match(prompt, /1:1/);
  assert.match(prompt, /主体居中/);
  assert.match(prompt, /安全区/);
});

test("Brief 默认使用竖屏画布，并接受三个受控预设", () => {
  assert.equal(parseBrief(REQUIRED_BRIEF).canvasPreset, "social-portrait");
  for (const canvasPreset of ["social-portrait", "social-landscape", "social-square"]) {
    assert.equal(parseBrief({ ...REQUIRED_BRIEF, canvasPreset }).canvasPreset, canvasPreset);
  }
});

test("Brief 拒绝任意画布值和尺寸对象", () => {
  assert.throws(() => parseBrief({ ...REQUIRED_BRIEF, canvasPreset: "4096x4096" }), /canvasPreset/);
  assert.throws(
    () => parseBrief({ ...REQUIRED_BRIEF, canvasPreset: { width: 1080, height: 1920 } }),
    /canvasPreset/
  );
});
