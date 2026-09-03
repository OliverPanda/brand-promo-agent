// M4 多语言（FR-12）：全局语言提示词机制纯函数测试。
import { test } from "node:test";
import assert from "node:assert/strict";
const { withGlobalLanguage, languageInstruction } = await import("../src/i18n.js");

test("zh-CN：不污染 prompt（原样返回）", () => {
  assert.equal(withGlobalLanguage("X", "zh-CN"), "X");
});

test("en/ja/ko/zh-TW：追加对应语言指令", () => {
  assert.match(withGlobalLanguage("X", "en"), /Output in English\./);
  assert.match(withGlobalLanguage("X", "ja"), /日本語/);
  assert.match(withGlobalLanguage("X", "ko"), /한국어/);
  assert.match(withGlobalLanguage("X", "zh-TW"), /繁体中文/);
});

test("未知语言：空指令不污染", () => {
  assert.equal(withGlobalLanguage("X", "xx"), "X");
  assert.equal(languageInstruction("xx"), "");
});
