/**
 * @file Playwright 配置：仅驱动浏览器验收用例（*.spec.mjs），不干扰 node:test 套件。
 * @description node:test 的用例文件名是 *.test.mjs，本配置用 testMatch 只采集 *.spec.mjs，
 *              避免两套测试框架互相抢文件；baseURL 可被 BASE_URL 覆盖以适配容器内访问宿主服务。
 */
import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  testMatch: ["**/*.spec.mjs"],
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 120_000,
  expect: { timeout: 30_000 },
  reporter: [["line"]],
  use: {
    baseURL: process.env.BASE_URL || "http://127.0.0.1:6777",
    headless: true,
  },
});