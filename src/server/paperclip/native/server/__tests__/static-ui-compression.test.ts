import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import express from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { nativeSecurityHeaders } from "../services/security-headers.js";
import {
  IMMUTABLE_CACHE_CONTROL,
  StaticCompressionCache,
  selectStaticEncoding,
  sendCompressedBody,
  staticUiCompression,
} from "../services/static-ui-compression.js";

// 发行层 1.1.8：静态 UI 源站压缩与缓存头回归（镜像 app.ts 静态分支的挂载顺序）。
let root: string;
const bigJs = `window.__x = ${JSON.stringify("a".repeat(40_000))};\n`;
const html = `<!doctype html><html lang="zh-CN"><body>${"<p>索引页</p>".repeat(200)}</body></html>`;

function buildApp() {
  const app = express();
  app.disable("x-powered-by");
  app.use(nativeSecurityHeaders({ publicUrl: "https://paperclip.example.invalid" }));
  const cache = new StaticCompressionCache();
  app.use(staticUiCompression({ root, cache }));
  app.use("/assets", express.static(path.join(root, "assets"), { maxAge: "1y", immutable: true }));
  app.get(["/", "/index.html"], (req, res) => {
    res.status(200).set("Cache-Control", "no-store");
    sendCompressedBody(req, res, Buffer.from(html), "text/html; charset=utf-8", cache);
  });
  app.use(express.static(root, { maxAge: "1h" }));
  app.get(/.*/, (req, res) => {
    if (req.path.startsWith("/assets/")) { res.status(404).end(); return; }
    res.status(200).set("Cache-Control", "no-store");
    sendCompressedBody(req, res, Buffer.from(html), "text/html; charset=utf-8", cache);
  });
  return app;
}

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "static-ui-compression-"));
  fs.mkdirSync(path.join(root, "assets"));
  fs.writeFileSync(path.join(root, "assets", "index-ABC123.js"), bigJs);
  fs.writeFileSync(path.join(root, "assets", "index-ABC123.css"), `.a{color:red}\n`.repeat(400));
  fs.writeFileSync(path.join(root, "assets", "logo-DEF456.png"), Buffer.alloc(4096, 1));
  fs.writeFileSync(path.join(root, "robots.txt"), "User-agent: *\n");
  fs.writeFileSync(path.join(root, "index.html"), html);
});
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

describe("static UI compression", () => {
  it("negotiates brotli before gzip and ignores unknown encodings", () => {
    expect(selectStaticEncoding("gzip, deflate, br")).toBe("br");
    expect(selectStaticEncoding("gzip, deflate")).toBe("gzip");
    expect(selectStaticEncoding("br;q=0, gzip")).toBe("gzip");
    expect(selectStaticEncoding("identity")).toBeNull();
    expect(selectStaticEncoding("*")).toBe("br");
    expect(selectStaticEncoding(undefined)).toBeNull();
  });

  it("serves hashed assets brotli-compressed, immutable, with the security headers intact", async () => {
    const res = await request(buildApp()).get("/assets/index-ABC123.js").set("Accept-Encoding", "gzip, deflate, br");
    expect(res.status).toBe(200);
    expect(res.headers["content-encoding"]).toBe("br");
    expect(res.headers["cache-control"]).toBe(IMMUTABLE_CACHE_CONTROL);
    expect(res.headers["vary"]).toBe("Accept-Encoding");
    expect(res.headers["content-type"]).toMatch(/javascript/);
    expect(res.headers["etag"]).toMatch(/^W\//);
    expect(Number(res.headers["content-length"])).toBeLessThan(bigJs.length / 10);
    // superagent 已按 Content-Encoding 解压；Content-Length 是压缩后的长度。
    expect(res.text).toBe(bigJs);
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["x-frame-options"]).toBe("SAMEORIGIN");
    expect(res.headers["strict-transport-security"]).toBe("max-age=15552000");
    expect(res.headers["x-powered-by"]).toBeUndefined();
  });

  it("falls back to gzip, answers 304 for a matching ETag and reuses the cache", async () => {
    const app = buildApp();
    const first = await request(app).get("/assets/index-ABC123.css").set("Accept-Encoding", "gzip");
    expect(first.headers["content-encoding"]).toBe("gzip");
    expect(first.text).toContain(".a{color:red}");
    const again = await request(app).get("/assets/index-ABC123.css").set("Accept-Encoding", "gzip").set("If-None-Match", first.headers["etag"]);
    expect(again.status).toBe(304);
    const head = await request(app).head("/assets/index-ABC123.css").set("Accept-Encoding", "gzip");
    expect(head.status).toBe(200);
    expect(head.headers["content-encoding"]).toBe("gzip");
  });

  it("leaves binaries, tiny files and clients without Accept-Encoding to express.static while keeping immutable assets immutable", async () => {
    const app = buildApp();
    const png = await request(app).get("/assets/logo-DEF456.png").set("Accept-Encoding", "br");
    expect(png.status).toBe(200);
    expect(png.headers["content-encoding"]).toBeUndefined();
    expect(png.headers["cache-control"]).toBe(IMMUTABLE_CACHE_CONTROL);
    const robots = await request(app).get("/robots.txt").set("Accept-Encoding", "br");
    expect(robots.status).toBe(200);
    expect(robots.headers["content-encoding"]).toBeUndefined();
    expect(robots.text).toContain("User-agent");
    const plain = await request(app).get("/assets/index-ABC123.js").set("Accept-Encoding", "identity");
    expect(plain.status).toBe(200);
    expect(plain.headers["content-encoding"]).toBeUndefined();
    expect(plain.headers["cache-control"]).toBe(IMMUTABLE_CACHE_CONTROL);
    expect(plain.text).toBe(bigJs);
  });

  it("serves the index shell no-store and compressed on the root and SPA fallback routes, never for /assets misses", async () => {
    const app = buildApp();
    for (const route of ["/", "/CMP/issues/CMP-1"]) {
      const res = await request(app).get(route).set("Accept-Encoding", "br");
      expect(res.status).toBe(200);
      expect(res.headers["cache-control"]).toBe("no-store");
      expect(res.headers["content-encoding"]).toBe("br");
      expect(res.headers["content-type"]).toMatch(/text\/html/);
      expect(res.text).toBe(html);
    }
    const miss = await request(app).get("/assets/missing-XYZ.js").set("Accept-Encoding", "br");
    expect(miss.status).toBe(404);
  });

  it("rejects traversal outside the UI root", async () => {
    const outside = path.join(path.dirname(root), `outside-${path.basename(root)}.js`);
    fs.writeFileSync(outside, "x".repeat(4096));
    try {
      // 非 /assets 路径落到 SPA 壳（200 text/html），绝不能返回根目录之外的文件内容。
      const res = await request(buildApp()).get(`/..%2F${path.basename(outside)}`).set("Accept-Encoding", "br");
      expect(res.headers["content-type"]).toMatch(/text\/html/);
      expect(res.text).not.toContain("xxxx");
      const assetRes = await request(buildApp()).get(`/assets/..%2F..%2F${path.basename(outside)}`).set("Accept-Encoding", "br");
      expect([403, 404]).toContain(assetRes.status);
    } finally { fs.rmSync(outside, { force: true }); }
  });
});
