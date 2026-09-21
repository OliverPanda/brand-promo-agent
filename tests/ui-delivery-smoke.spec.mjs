/**
 * @file 成片交付前端验收（Playwright）：在三个视口打开 /?runId=<REAL_RUN_ID> 并校验成片交付区。
 * @description 覆盖 PRD FR-7.4/FR-8.1：无横向溢出、无页面错误、成片可加载元数据、
 *              画布与模型标签可见、三个下载入口各返回 200 与约定 MIME。
 *              用例按视口参数化，运行方式见 docs/superpowers/plans/2026-09-20-real-mp4-delivery-implementation.md Step 4。
 */
import { test, expect } from "@playwright/test";

const RUN_ID = process.env.REAL_RUN_ID || "";
const VIEWPORTS = [
  { name: "desktop-1440", width: 1440, height: 900 },
  { name: "tablet-768", width: 768, height: 900 },
  { name: "mobile-375", width: 375, height: 812 },
];

/** 下载入口的约定 MIME 前缀（后缀可能带 charset）。 */
const ARTIFACTS = [
  { kind: "video", label: "下载 MP4", mime: "video/mp4" },
  { kind: "subtitles", label: "下载字幕 SRT", mime: "application/x-subrip" },
  { kind: "poster", label: "下载封面", mime: "image/" },
];

test.describe("REAL 成片交付区", () => {
  test.skip(!RUN_ID, "缺少 REAL_RUN_ID，跳过浏览器验收");

  test.beforeAll(async ({ request }) => {
    // 说明：先确认服务端确实是 REAL 且该 run 已完成，否则后续断言失败原因会指向前端，掩盖真实问题。
    const config = await request.get("/api/config");
    expect(config.status(), "GET /api/config").toBe(200);
    const configBody = await config.json();
    expect(configBody.mode, "服务端应为 REAL 模式").toBe("real");

    const run = await request.get(`/api/runs/${encodeURIComponent(RUN_ID)}`);
    expect(run.status(), `GET /api/runs/${RUN_ID}`).toBe(200);
    const body = await run.json();
    expect(body.status, "验收 run 必须已成功").toBe("success");
    expect(body.artifactManifest?.validated, "成片产物清单必须已校验").toBe(true);
  });

  for (const viewport of VIEWPORTS) {
    test(`${viewport.name} 视口成片交付区完整可用`, async ({ page, request }) => {
      const pageErrors = [];
      page.on("pageerror", (error) => pageErrors.push(String(error?.message || error)));
      await page.setViewportSize({ width: viewport.width, height: viewport.height });

      const response = await page.goto(`/?runId=${encodeURIComponent(RUN_ID)}`, { waitUntil: "domcontentloaded" });
      expect(response?.status(), "首页响应").toBe(200);

      const video = page.locator("video.final-video");
      await expect(video, "成片播放器应渲染").toHaveCount(1);

      // 元数据：Chromium 构建若不含 H.264 专有解码器，canPlayType 为空属环境限制；
      // 此时按 HTTP 层（Range 可读 + 正确 MIME）判定成片可用，避免把浏览器编解码能力误判成交付缺陷。
      const h264 = await page.evaluate(() => document.createElement("video").canPlayType('video/mp4; codecs="avc1.42E01E"'));
      if (h264) {
        await expect
          .poll(() => video.evaluate((el) => el.readyState), { message: "成片应加载到元数据（readyState ≥ 1）" })
          .toBeGreaterThanOrEqual(1);
      } else {
        const range = await request.get(`/api/video/${encodeURIComponent(RUN_ID)}`, { headers: { Range: "bytes=0-1023" } });
        expect([200, 206], "缺少 H.264 解码器时改用 Range 请求校验成片可读").toContain(range.status());
        expect(range.headers()["content-type"]).toContain("video/mp4");
        test.info().annotations.push({ type: "environment", description: "浏览器无 H.264 解码器，元数据断言降级为 HTTP Range 校验" });
      }

      const kv = page.locator("#delivery .kv");
      await expect(kv.filter({ hasText: "画布：" }), "应显示画布与分辨率").toContainText("1080×1920");
      await expect(page.locator("#delivery"), "应显示动态视频模型").toContainText("动态视频");
      await expect(page.locator("#delivery"), "应显示配音模型").toContainText("配音");
      await expect(page.locator("#delivery"), "应显示配乐模型").toContainText("配乐");

      for (const artifact of ARTIFACTS) {
        const link = page.locator(`a.dl[href="/api/runs/${RUN_ID}/artifacts/${artifact.kind}"]`);
        await expect(link, `${artifact.label} 入口应存在`).toHaveCount(1);
        const download = await request.get(`/api/runs/${RUN_ID}/artifacts/${artifact.kind}`);
        expect(download.status(), `${artifact.kind} 下载状态`).toBe(200);
        expect(download.headers()["content-type"], `${artifact.kind} MIME`).toContain(artifact.mime);
        expect(download.headers()["content-disposition"], `${artifact.kind} 应带下载文件名`).toContain("attachment");
        expect((await download.body()).byteLength, `${artifact.kind} 不应为空`).toBeGreaterThan(0);
      }

      const overflow = await page.evaluate(() => ({
        scrollWidth: document.documentElement.scrollWidth,
        innerWidth: window.innerWidth,
      }));
      expect(overflow.scrollWidth, `横向溢出：scrollWidth=${overflow.scrollWidth} > innerWidth=${overflow.innerWidth}`)
        .toBeLessThanOrEqual(overflow.innerWidth);

      expect(pageErrors, "页面不应抛出未捕获错误").toEqual([]);
    });
  }
});