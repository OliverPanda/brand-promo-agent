/**
 * @file 全片视觉风格固化单测。
 * @description 锁定风格注册表的不可变性、锚点的确定性与唯一性，以及 Brief 层的受控校验，
 * 防止「第一个分镜真人、后续动漫」的画风漂移回归。
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_STYLE_PRESET,
  STYLE_DESCRIPTION_MAX,
  STYLE_PRESETS,
  resolveStyle,
  styleManifest,
  stylePrompt,
} from "../src/media/style.js";
import { parseBrief } from "../src/schemas.js";

const REQUIRED_BRIEF = {
  brandName: "铭星科技",
  productName: "星链 Pro",
  coreSellingPoint: "一句话生成专业宣传片",
};

const ALL_PRESETS = ["photoreal", "anime", "three-d", "illustration", "ink-wash", "custom"];
const FIVE_PRESETS = ["photoreal", "anime", "three-d", "illustration", "ink-wash"];

test("风格注册表包含六个不可变预设，默认与 PRD 一致", () => {
  assert.equal(DEFAULT_STYLE_PRESET, "photoreal");
  assert.equal(STYLE_DESCRIPTION_MAX, 200);
  assert.deepEqual(Object.keys(STYLE_PRESETS), ALL_PRESETS);
  assert.equal(Object.isFrozen(STYLE_PRESETS), true);
  for (const id of ALL_PRESETS) {
    const preset = STYLE_PRESETS[id];
    assert.equal(preset.id, id, id + " 的 id 必须与 key 一致");
    assert.equal(Object.isFrozen(preset), true, id + " 的配置必须冻结");
    assert.ok(typeof preset.label === "string" && preset.label.length > 0, id + " 必须有中文标签");
    assert.ok(typeof preset.anchor === "string" && preset.anchor.length > 0, id + " 必须有风格锚点");
  }
  assert.deepEqual(resolveStyle(), STYLE_PRESETS.photoreal);
});

test("六个预设的锚点两两不同，且都覆盖画风/光影/材质/色彩四维", () => {
  const anchors = ALL_PRESETS.map((id) => STYLE_PRESETS[id].anchor);
  assert.equal(new Set(anchors).size, ALL_PRESETS.length, "锚点不得重复");
  for (const id of ALL_PRESETS) {
    const anchor = STYLE_PRESETS[id].anchor;
    for (const dimension of ["画风", "光影", "材质", "色彩"]) {
      assert.match(anchor, new RegExp(dimension), id + " 锚点缺少 " + dimension + " 维度");
    }
  }
});

test("resolveStyle 拒绝未知值与继承属性，不做静默回落", () => {
  for (const bad of ["realistic", "PHOTOREAL", "", "3d", "toString", "constructor", "__proto__", "hasOwnProperty"]) {
    assert.throws(() => resolveStyle(bad), /不支持的画面风格/, String(bad) + " 必须抛错");
  }
});

test("stylePrompt 对同一 Brief 恒定，且五个预设两两不同", () => {
  const brief = { stylePreset: "anime" };
  assert.equal(stylePrompt(brief), stylePrompt({ ...brief }));
  const prompts = FIVE_PRESETS.map((stylePreset) => stylePrompt({ ...REQUIRED_BRIEF, stylePreset }));
  assert.equal(new Set(prompts).size, FIVE_PRESETS.length, "不同预设必须产出不同锚点");
  for (const [index, prompt] of prompts.entries()) {
    assert.match(prompt, /全片统一风格锚点/);
    assert.match(prompt, /全片所有镜头必须沿用同一画风/, FIVE_PRESETS[index] + " 缺少全片一致硬约束");
    // 锚点必须原文出现，确保展示的提示词就是注册表里的那一份，而不是同义改写。
    assert.ok(prompt.includes(STYLE_PRESETS[FIVE_PRESETS[index]].anchor), FIVE_PRESETS[index] + " 锚点必须原文出现在提示词中");
  }
});

test("stylePrompt：custom 缺描述抛错，有描述时拼接用户原文", () => {
  assert.throws(() => stylePrompt({ stylePreset: "custom" }), /必须提供风格描述/);
  assert.throws(() => stylePrompt({ stylePreset: "custom", styleDescription: "   " }), /必须提供风格描述/);
  const prompt = stylePrompt({ stylePreset: "custom", styleDescription: "黏土定格动画" });
  assert.match(prompt, /黏土定格动画/);
  assert.match(prompt, /全片所有镜头必须沿用同一画风/);
  assert.match(prompt, /不得自行改换或混搭其他画风/);
});

test("styleManifest 记录交付回显所需字段", () => {
  assert.deepEqual(styleManifest(undefined), { preset: "photoreal", label: "真人实拍", description: "" });
  assert.deepEqual(styleManifest({ stylePreset: "ink-wash" }), { preset: "ink-wash", label: "国风水墨", description: "" });
  assert.deepEqual(
    styleManifest({ stylePreset: "custom", styleDescription: " 黏土定格 " }),
    { preset: "custom", label: "自定义", description: "黏土定格" },
  );
});

test("Brief 默认真人实拍，接受六个受控预设", () => {
  assert.equal(parseBrief(REQUIRED_BRIEF).stylePreset, "photoreal");
  for (const stylePreset of FIVE_PRESETS) {
    assert.equal(parseBrief({ ...REQUIRED_BRIEF, stylePreset }).stylePreset, stylePreset);
  }
  const custom = parseBrief({ ...REQUIRED_BRIEF, stylePreset: "custom", styleDescription: "黏土定格动画" });
  assert.equal(custom.stylePreset, "custom");
  assert.equal(custom.styleDescription, "黏土定格动画");
});

test("Brief 拒绝未知风格与超长描述，custom 缺描述报 styleDescription", () => {
  assert.throws(() => parseBrief({ ...REQUIRED_BRIEF, stylePreset: "cyberpunk" }), /stylePreset/);
  assert.throws(() => parseBrief({ ...REQUIRED_BRIEF, stylePreset: "" }), /stylePreset/);
  assert.throws(
    () => parseBrief({ ...REQUIRED_BRIEF, styleDescription: "x".repeat(STYLE_DESCRIPTION_MAX + 1) }),
    /styleDescription/,
  );
  assert.throws(
    () => parseBrief({ ...REQUIRED_BRIEF, stylePreset: "custom" }),
    /styleDescription: 画面风格为自定义时必须填写风格描述/,
  );
  assert.throws(
    () => parseBrief({ ...REQUIRED_BRIEF, stylePreset: "custom", styleDescription: "  " }),
    /styleDescription: 画面风格为自定义时必须填写风格描述/,
  );
});
