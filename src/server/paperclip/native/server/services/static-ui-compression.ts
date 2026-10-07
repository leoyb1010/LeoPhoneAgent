import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { brotliCompressSync, constants as zlibConstants, gzipSync } from "node:zlib";
import type { Request, RequestHandler, Response } from "express";

/**
 * 发行层 1.1.8：静态 UI 产物的源站压缩与缓存头。
 * 上游只对 /api JSON 做 gzip；6.5 MB 的 index-*.js 以原文经隧道回源，Cloudflare 缓存未命中时首屏 10 秒。
 * - 只处理 GET/HEAD 且扩展名为文本类（js/mjs/css/json/svg/html/txt/map/xml/webmanifest/wasm）的文件；
 * - 优先 brotli（静态产物只压一次，质量 9），其次 gzip；结果按 路径+mtime+大小 缓存在内存（上限 96 MiB）；
 * - 带 Accept-Encoding 的 1 KiB 以下文件与非压缩类型交给上游 express.static 原样处理；
 * - 哈希产物 /assets/* 为 `public, max-age=31536000, immutable`；弱 ETag 支持 304；始终 `Vary: Accept-Encoding`。
 * 不改动安全响应头（由 nativeSecurityHeaders 在最前面设置）。
 */
const COMPRESSIBLE = new Set([".js", ".mjs", ".css", ".json", ".svg", ".html", ".txt", ".map", ".xml", ".webmanifest", ".wasm"]);
const MIN_BYTES = 1024;
const MAX_CACHE_BYTES = 96 * 1024 * 1024;
export const IMMUTABLE_CACHE_CONTROL = "public, max-age=31536000, immutable";

type Encoding = "br" | "gzip";
type CacheEntry = { key: string; bytes: number; body: Buffer; etag: string };

export function selectStaticEncoding(acceptEncoding: string | string[] | undefined): Encoding | null {
  const raw = (Array.isArray(acceptEncoding) ? acceptEncoding.join(",") : acceptEncoding ?? "").toLowerCase();
  if (!raw) return null;
  const q = (name: string): number => {
    const part = raw.split(",").map((p) => p.trim()).find((p) => p.split(";")[0].trim() === name);
    if (!part) return name === "*" ? 0 : -1;
    const m = /q=([0-9.]+)/.exec(part);
    return m ? Number(m[1]) : 1;
  };
  const star = q("*");
  const br = q("br") >= 0 ? q("br") : star;
  const gz = q("gzip") >= 0 ? q("gzip") : star;
  if (br > 0) return "br";
  if (gz > 0) return "gzip";
  return null;
}

export function compressStaticBuffer(body: Buffer, encoding: Encoding): Buffer {
  return encoding === "br"
    ? brotliCompressSync(body, { params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 9, [zlibConstants.BROTLI_PARAM_SIZE_HINT]: body.length } })
    : gzipSync(body, { level: 8 });
}

export class StaticCompressionCache {
  private readonly entries = new Map<string, CacheEntry>();
  private total = 0;
  constructor(private readonly maxBytes = MAX_CACHE_BYTES) {}
  get(key: string): CacheEntry | undefined {
    const entry = this.entries.get(key);
    if (entry) { this.entries.delete(key); this.entries.set(key, entry); }
    return entry;
  }
  put(key: string, body: Buffer, etag: string): CacheEntry {
    const entry: CacheEntry = { key, bytes: body.length, body, etag };
    this.entries.set(key, entry);
    this.total += body.length;
    for (const [oldKey, old] of this.entries) {
      if (this.total <= this.maxBytes || oldKey === key) break;
      this.entries.delete(oldKey);
      this.total -= old.bytes;
    }
    return entry;
  }
  get size(): number { return this.entries.size; }
}

function cacheControlFor(urlPath: string): string | null {
  return urlPath.startsWith("/assets/") ? IMMUTABLE_CACHE_CONTROL : null;
}

/** 把已生成的正文（例如品牌化后的 index.html）按协商编码压缩后发送；调用方负责 Cache-Control 与状态码。 */
export function sendCompressedBody(req: Request, res: Response, body: Buffer, contentType: string, cache?: StaticCompressionCache): void {
  res.setHeader("Vary", "Accept-Encoding");
  res.setHeader("Content-Type", contentType);
  const encoding = body.length >= MIN_BYTES ? selectStaticEncoding(req.headers["accept-encoding"]) : null;
  let payload = body;
  if (encoding) {
    const hash = crypto.createHash("sha1").update(body).digest("hex");
    const key = `body:${hash}:${encoding}`;
    payload = (cache?.get(key) ?? cache?.put(key, compressStaticBuffer(body, encoding), hash) ?? { body: compressStaticBuffer(body, encoding) }).body;
    res.setHeader("Content-Encoding", encoding);
  }
  res.setHeader("Content-Length", String(payload.length));
  if (req.method === "HEAD") { res.end(); return; }
  res.end(payload);
}

export function staticUiCompression(options: { root: string; cache?: StaticCompressionCache }): RequestHandler {
  const root = path.resolve(options.root);
  const cache = options.cache ?? new StaticCompressionCache();
  return (req, res, next) => {
    if (req.method !== "GET" && req.method !== "HEAD") { next(); return; }
    let urlPath: string;
    try { urlPath = decodeURIComponent(req.path); } catch { next(); return; }
    if (urlPath.includes("\0") || urlPath.split("/").includes("..")) { next(); return; }
    const ext = path.extname(urlPath).toLowerCase();
    if (!COMPRESSIBLE.has(ext) || urlPath.endsWith("/index.html") || urlPath === "/") { next(); return; }
    const filePath = path.resolve(root, `.${urlPath}`);
    if (filePath !== root && !filePath.startsWith(root + path.sep)) { next(); return; }
    let stat: fs.Stats;
    try { stat = fs.statSync(filePath); } catch { next(); return; }
    if (!stat.isFile()) { next(); return; }
    const encoding = stat.size >= MIN_BYTES ? selectStaticEncoding(req.headers["accept-encoding"]) : null;
    const cacheControl = cacheControlFor(urlPath);
    if (!encoding) {
      // 不压缩时仍统一哈希产物的缓存头，其余交给上游 express.static。
      if (cacheControl) res.setHeader("Cache-Control", cacheControl);
      res.setHeader("Vary", "Accept-Encoding");
      next();
      return;
    }
    const etag = `W/"${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}-${encoding}"`;
    res.setHeader("Vary", "Accept-Encoding");
    if (cacheControl) res.setHeader("Cache-Control", cacheControl);
    res.setHeader("ETag", etag);
    if (req.headers["if-none-match"] === etag) { res.status(304).end(); return; }
    const key = `${filePath}:${stat.mtimeMs}:${stat.size}:${encoding}`;
    const entry = cache.get(key) ?? cache.put(key, compressStaticBuffer(fs.readFileSync(filePath), encoding), etag);
    res.status(200);
    res.type(ext === ".map" ? "application/json" : ext === ".webmanifest" ? "application/manifest+json" : ext);
    res.setHeader("Content-Encoding", encoding);
    res.setHeader("Content-Length", String(entry.body.length));
    if (req.method === "HEAD") { res.end(); return; }
    res.end(entry.body);
  };
}
