/**
 * @file 共享媒体物化器测试。
 * @description 使用本地 HTTP fixture 覆盖 data/http/file 输入与安全拒绝路径。
 */
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { MEDIA_LIMITS } from "../src/media/artifacts.js";
import { materializeMedia } from "../src/media/materialize.js";

const roots = [];
const servers = [];
const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 20]), Buffer.from("ftypisom"), Buffer.alloc(16)]);
const WAV = Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WAVEfmt "), Buffer.alloc(16)]);

function workspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "promo-materialize-"));
  roots.push(root);
  return root;
}

async function fixture(handler) {
  const server = http.createServer(handler);
  servers.push(server);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${server.address().port}`;
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))));
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

test("物化 image/video/audio data URL 并按魔数生成碰撞安全文件名", async () => {
  const dir = workspace();
  const inputs = [
    ["image", "image/png", PNG, ".png"],
    ["video", "video/mp4", MP4, ".mp4"],
    ["audio", "audio/wav", WAV, ".wav"],
  ];
  const names = new Set();
  for (const [kind, mime, bytes, ext] of inputs) {
    const file = await materializeMedia({ source: `data:${mime};base64,${bytes.toString("base64")}`, kind, workspace: dir });
    assert.ok(file.startsWith(`${path.resolve(dir)}${path.sep}`));
    assert.equal(path.extname(file), ext);
    assert.deepEqual(fs.readFileSync(file), bytes);
    names.add(path.basename(file));
  }
  const again = await materializeMedia({ source: `data:image/png;base64,${PNG.toString("base64")}`, kind: "image", workspace: dir });
  names.add(path.basename(again));
  assert.equal(names.size, 4);
});

test("HTTP 使用流式边界并验证 MIME 与最终魔数", async () => {
  const base = await fixture((req, res) => {
    if (req.url === "/png") {
      res.writeHead(200, { "Content-Type": "image/png" });
      res.end(PNG);
      return;
    }
    if (req.url === "/wrong-mime") {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end(PNG);
      return;
    }
    res.writeHead(200, { "Content-Type": "image/png" });
    res.end(Buffer.from("not an image"));
  });
  const dir = workspace();
  const file = await materializeMedia({ source: `${base}/png`, kind: "image", workspace: dir });
  assert.deepEqual(fs.readFileSync(file), PNG);
  await assert.rejects(materializeMedia({ source: `${base}/wrong-mime`, kind: "image", workspace: dir }), /MIME/);
  await assert.rejects(materializeMedia({ source: `${base}/wrong-magic`, kind: "image", workspace: dir }), /格式|魔数/);
});

test("HTTP 可物化 video 与 audio 并验证真实容器签名", async () => {
  const base = await fixture((req, res) => {
    if (req.url === "/video") {
      res.writeHead(200, { "Content-Type": "video/mp4" });
      return res.end(MP4);
    }
    res.writeHead(200, { "Content-Type": "audio/wav" });
    return res.end(WAV);
  });
  const dir = workspace();
  const video = await materializeMedia({ source: `${base}/video`, kind: "video", workspace: dir });
  const audio = await materializeMedia({ source: `${base}/audio`, kind: "audio", workspace: dir });
  assert.deepEqual(fs.readFileSync(video), MP4);
  assert.deepEqual(fs.readFileSync(audio), WAV);
});

test("仅允许读取 workspace 内的服务端文件", async () => {
  const dir = workspace();
  const inside = path.join(dir, "输入.png");
  fs.writeFileSync(inside, PNG);
  const plain = await materializeMedia({ source: inside, kind: "image", workspace: dir });
  const url = await materializeMedia({ source: pathToFileURL(inside).href, kind: "image", workspace: dir });
  assert.deepEqual(fs.readFileSync(plain), PNG);
  assert.deepEqual(fs.readFileSync(url), PNG);
  const outside = path.join(path.dirname(dir), "outside.png");
  fs.writeFileSync(outside, PNG);
  try {
    await assert.rejects(materializeMedia({ source: outside, kind: "image", workspace: dir }), /工作区|越界/);
    await assert.rejects(materializeMedia({ source: pathToFileURL(outside).href, kind: "image", workspace: dir }), /工作区|越界/);
  } finally {
    fs.rmSync(outside, { force: true });
  }
});

test("workspace 文件输入支持 video 与 audio", async () => {
  const dir = workspace();
  const videoInput = path.join(dir, "input.mp4");
  const audioInput = path.join(dir, "input.wav");
  fs.writeFileSync(videoInput, MP4);
  fs.writeFileSync(audioInput, WAV);
  const video = await materializeMedia({ source: videoInput, kind: "video", workspace: dir });
  const audio = await materializeMedia({ source: audioInput, kind: "audio", workspace: dir });
  assert.deepEqual(fs.readFileSync(video), MP4);
  assert.deepEqual(fs.readFileSync(audio), WAV);
});

test("拒绝通过 workspace 内目录联接读取外部本地文件", async (t) => {
  const dir = workspace();
  const outsideDir = workspace();
  const outside = path.join(outsideDir, "outside.png");
  fs.writeFileSync(outside, PNG);
  const link = path.join(dir, "linked-outside");
  try {
    fs.symlinkSync(outsideDir, link, process.platform === "win32" ? "junction" : "dir");
  } catch (error) {
    t.skip(`当前环境不允许创建目录联接：${error.code || error.message}`);
    return;
  }
  await assert.rejects(
    materializeMedia({ source: path.join(link, "outside.png"), kind: "image", workspace: dir }),
    /工作区|越界/,
  );
});

test("拒绝空响应、超限响应、非 HTTP 重定向与循环重定向", async () => {
  const original = MEDIA_LIMITS.maxImageBytes;
  MEDIA_LIMITS.maxImageBytes = 8;
  const base = await fixture((req, res) => {
    if (req.url === "/empty") {
      res.writeHead(200, { "Content-Type": "image/png" });
      return res.end();
    }
    if (req.url === "/large") {
      res.writeHead(200, { "Content-Type": "image/png" });
      return res.end(Buffer.concat([PNG, Buffer.alloc(32)]));
    }
    if (req.url === "/file-redirect") {
      res.writeHead(302, { Location: "file:///etc/passwd" });
      return res.end();
    }
    res.writeHead(302, { Location: "/loop" });
    res.end();
  });
  const dir = workspace();
  try {
    await assert.rejects(materializeMedia({ source: `${base}/empty`, kind: "image", workspace: dir }), /空/);
    await assert.rejects(materializeMedia({ source: `${base}/large`, kind: "image", workspace: dir }), /过大|上限/);
    await assert.rejects(materializeMedia({ source: `${base}/file-redirect`, kind: "image", workspace: dir }), /重定向|HTTP/);
    await assert.rejects(materializeMedia({ source: `${base}/loop`, kind: "image", workspace: dir }), /重定向/);
  } finally {
    MEDIA_LIMITS.maxImageBytes = original;
  }
});

test("HTTP 下载超时会中止且不留下文件", async () => {
  const base = await fixture((_req, res) => setTimeout(() => res.end(PNG), 100));
  const dir = workspace();
  await assert.rejects(materializeMedia({ source: base, kind: "image", workspace: dir, downloadTimeoutMs: 20 }), /超时/);
  assert.deepEqual(fs.readdirSync(dir), []);
});

test("HTTP 在进入落盘管线前拒绝响应时取消 body 并关闭服务端流", async () => {
  let resolveClosed;
  const closed = new Promise((resolve) => { resolveClosed = resolve; });
  const base = await fixture((req, res) => {
    res.writeHead(200, { "Content-Type": "text/plain" });
    const interval = setInterval(() => res.write(Buffer.alloc(1024)), 5);
    req.on("close", () => {
      clearInterval(interval);
      resolveClosed();
    });
  });
  await assert.rejects(materializeMedia({ source: base, kind: "video", workspace: workspace() }), /MIME/);
  await Promise.race([
    closed,
    new Promise((_, reject) => setTimeout(() => reject(new Error("响应 body 未取消，服务端流仍保持连接")), 1_000)),
  ]);
});

test("拒绝 data URL 的错误 MIME、错误魔数和空数据", async () => {
  const dir = workspace();
  await assert.rejects(materializeMedia({ source: `data:text/plain;base64,${PNG.toString("base64")}`, kind: "image", workspace: dir }), /MIME/);
  await assert.rejects(materializeMedia({ source: `data:image/png;base64,${Buffer.from("bad").toString("base64")}`, kind: "image", workspace: dir }), /格式|魔数/);
  await assert.rejects(materializeMedia({ source: "data:image/png;base64,", kind: "image", workspace: dir }), /空/);
});

test("base64 解码字节数精确处理 padding：各类型上限本身可接受，上限加一被拒绝", async () => {
  const dir = workspace();
  const cases = [
    ["image", "image/png", "maxImageBytes", PNG],
    ["video", "video/mp4", "maxVideoBytes", MP4],
    ["audio", "audio/wav", "maxAudioBytes", Buffer.concat([WAV, Buffer.alloc(2)])],
  ];
  for (const [kind, mime, limitKey, exactBytes] of cases) {
    const original = MEDIA_LIMITS[limitKey];
    MEDIA_LIMITS[limitKey] = exactBytes.length;
    try {
      const exact = await materializeMedia({
        source: `data:${mime};base64,${exactBytes.toString("base64")}`,
        kind,
        workspace: dir,
      });
      assert.deepEqual(fs.readFileSync(exact), exactBytes, `${limitKey} 精确边界应通过`);
      const overflow = Buffer.concat([exactBytes, Buffer.from([0])]);
      await assert.rejects(
        materializeMedia({ source: `data:${mime};base64,${overflow.toString("base64")}`, kind, workspace: dir }),
        /过大|上限/,
        `${limitKey} + 1 字节应拒绝`,
      );
    } finally {
      MEDIA_LIMITS[limitKey] = original;
    }
  }
});

test("必须显式提供服务端创建的 workspace", async () => {
  await assert.rejects(
    materializeMedia({ source: `data:image/png;base64,${PNG.toString("base64")}`, kind: "image" }),
    /workspace|工作区/,
  );
});
