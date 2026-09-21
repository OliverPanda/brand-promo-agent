/**
 * @file OpenAPI 交付契约测试。
 * @description 校验 docs/openapi.json 是合法 OpenAPI 3.1，并与 server.js 实际注册的交付路由一致，
 * 防止文档漂移：文档里写的每个 method+path 都必须在服务端真实存在，反之关键新路由也必须在文档中登记。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const specPath = path.resolve(__dirname, "../docs/openapi.json");
const serverSource = fs.readFileSync(path.resolve(__dirname, "../src/server.js"), "utf8");

test("docs/openapi.json 是合法 OpenAPI 3.1 且覆盖全部交付路由", () => {
  const spec = JSON.parse(fs.readFileSync(specPath, "utf8"));
  assert.equal(spec.openapi, "3.1.0");
  assert.equal(typeof spec.info?.title, "string");
  assert.equal(typeof spec.info?.version, "string");
  assert.ok(spec.paths && typeof spec.paths === "object");

  for (const [route, method, expressRoute] of REQUIRED_ROUTES) {
    const operation = spec.paths[route]?.[method];
    assert.ok(operation, `OpenAPI 缺少 ${method.toUpperCase()} ${route}`);
    assert.equal(typeof operation.summary, "string", `${route} 缺少 summary`);
    assert.ok(operation.responses && Object.keys(operation.responses).length > 0, `${route} 缺少 responses`);
    // 说明：产物路由在服务端由同一个 :kind 处理器分发，所以按显式 Express 路径断言，避免把 {runId}/{kind} 误当字面量。
    assert.ok(expressPattern(expressRoute || route).test(serverSource), `${route} 在 src/server.js 中不存在对应路由`);
  }
});

test("交付下载契约声明了媒体类型、Range 与附件下载语义", () => {
  const spec = JSON.parse(fs.readFileSync(specPath, "utf8"));
  const video = spec.paths["/api/video/{runId}"].get;
  assert.ok(Object.keys(video.responses["200"].content).includes("video/mp4"));
  assert.equal(video.responses["206"]?.description?.includes("Range"), true, "206 必须说明 Range 语义");
  assert.equal(video.responses["404"] !== undefined, true);

  const downloadable = {
    "/api/runs/{runId}/artifacts/video": "video/mp4",
    "/api/runs/{runId}/artifacts/subtitles": "application/x-subrip",
    "/api/runs/{runId}/artifacts/poster": "image/jpeg",
  };
  for (const [route, mime] of Object.entries(downloadable)) {
    const operation = spec.paths[route].get;
    assert.deepEqual(Object.keys(operation.responses["200"].content), [mime], `${route} 媒体类型应为 ${mime}`);
    assert.match(operation.responses["200"].headers?.["Content-Disposition"]?.description || "", /attachment/, `${route} 必须声明附件下载`);
    assert.equal(operation.responses["409"]?.description !== undefined, true, `${route} 应声明未就绪 409`);
  }
});

test("重跑契约限定 failed 输入并声明 201/404/409", () => {
  const spec = JSON.parse(fs.readFileSync(specPath, "utf8"));
  const rerun = spec.paths["/api/runs/{runId}/rerun"].post;
  for (const status of ["201", "404", "409"]) {
    assert.equal(rerun.responses[status] !== undefined, true, `rerun 应声明 ${status}`);
  }
  assert.equal(rerun.responses["201"].content["application/json"].schema.required.includes("runId"), true);
  assert.match(rerun.description || "", /failed/);
});

/** 文档化路径 → Express 路由正则（OpenAPI 用 {runId}，Express 用 :runId）。 */
function expressPattern(route) {
  const expressPath = route.replace(/\{([A-Za-z0-9_]+)\}/g, ":$1");
  const escaped = expressPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp('app\\.(?:get|post|put|delete)\\("' + escaped + '"');
}

const REQUIRED_ROUTES = [
  ["/api/generate", "post"],
  ["/api/runs/{runId}/rerun", "post"],
  ["/api/video/{runId}", "get"],
  ["/api/runs/{runId}/artifacts/video", "get", "/api/runs/{runId}/artifacts/{kind}"],
  ["/api/runs/{runId}/artifacts/subtitles", "get", "/api/runs/{runId}/artifacts/{kind}"],
  ["/api/runs/{runId}/artifacts/poster", "get", "/api/runs/{runId}/artifacts/{kind}"],
];
