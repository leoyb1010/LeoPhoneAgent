import type { IncomingMessage } from "node:http";
import { PassThrough, Readable, type Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createBrotliDecompress, createGunzip } from "node:zlib";
import { DeflateDecoder } from "./deflate-decoder.js";

const NULL_BODY_STATUSES = new Set([204, 205, 304]);

/** Node 的公网 DNS transport 也必须遵循 fetch 的空响应/解压语义。 */
export function rawHttpResponse(message: IncomingMessage, method: string, signal: AbortSignal): Response {
  const headers = new Headers();
  for (const [name, value] of Object.entries(message.headers)) {
    if (Array.isArray(value)) {
      for (const item of value) headers.append(name, item);
    } else if (value !== undefined) headers.append(name, String(value));
  }
  const status = message.statusCode ?? 502;
  const init = { headers, status, statusText: message.statusMessage };
  if (method.toUpperCase() === "HEAD" || NULL_BODY_STATUSES.has(status)) {
    const response = new Response(null, init);
    message.destroy();
    return response;
  }

  const encodings = (headers.get("content-encoding") ?? "").split(",")
    .map((encoding) => encoding.trim().toLowerCase()).filter(Boolean);
  const decoders = encodings.reverse().flatMap<Transform>((encoding) => {
    switch (encoding) {
      case "identity": return [];
      case "gzip": case "x-gzip": return [createGunzip()];
      case "deflate": return [new DeflateDecoder()];
      case "br": return [createBrotliDecompress()];
      default: throw new Error(`Unsupported HTTP content encoding: ${encoding}`);
    }
  });
  if (decoders.length) {
    // readResponseBody 的限额针对解压后的字节，不能把 wire length 当正文长度。
    headers.delete("content-length");
    headers.delete("content-encoding");
  }
  const body = new PassThrough();
  const response = new Response(Readable.toWeb(body) as ReadableStream<Uint8Array>, init);
  // pipeline 将解码失败/abort/cancel 传播至整个链，避免后台 socket 或未处理 error。
  void pipeline([message, ...decoders, body], { signal }).catch(() => undefined);
  return response;
}
