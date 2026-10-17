import type { IncomingMessage } from "node:http";
import { PassThrough, Readable, type Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createBrotliDecompress, createGunzip } from "node:zlib";
import { DeflateDecoder } from "./deflate-decoder.js";
import type { ResponseLike } from "./response-body.js";

/** Fetch 规范的 null body status：这些响应没有正文。 */
const NULL_BODY_STATUSES = new Set([101, 103, 204, 205, 304]);
/** HTTP 状态码是三位数；超出 `Response` 的 200–599 也照样原样返回（如 LinkedIn 对爬虫回 999）。 */
const MIN_HTTP_STATUS = 100;
const MAX_HTTP_STATUS = 999;

export interface RawHttpResponse extends ResponseLike {
  statusText: string;
}

/**
 * [leo] Node 的公网 DNS transport 也必须遵循 fetch 的空响应 / 解压语义。
 *
 * 不包成 WHATWG `Response`（它表示不了 999 这类状态码，构造函数在回调里抛错会打死进程），
 * 而是返回 ResponseLike：状态码原样带回（合法三位数），null body 状态不给流，
 * gzip / deflate / br 在这里解压（上游 3.15.1 的 readIncomingResponse 不解压，WebFetch 会拿到压缩字节）。
 * 非法状态码 / 非法响应头同步抛错，由调用方转成这一次请求的 reject。
 */
export function rawHttpResponse(
  message: IncomingMessage,
  method: string,
  signal: AbortSignal,
): RawHttpResponse {
  const headers = new Headers();
  for (const [name, value] of Object.entries(message.headers)) {
    if (Array.isArray(value)) {
      for (const item of value) headers.append(name, item);
    } else if (value !== undefined) headers.append(name, String(value));
  }
  const status = message.statusCode ?? 502;
  if (!Number.isInteger(status) || status < MIN_HTTP_STATUS || status > MAX_HTTP_STATUS) {
    throw new RangeError(`Invalid HTTP response status ${status}`);
  }
  const statusText = message.statusMessage ?? "";
  if (method.toUpperCase() === "HEAD" || NULL_BODY_STATUSES.has(status)) {
    message.destroy();
    return { status, statusText, headers, body: null };
  }

  const encodings = (headers.get("content-encoding") ?? "")
    .split(",")
    .map((encoding) => encoding.trim().toLowerCase())
    .filter(Boolean);
  const decoders = encodings.reverse().flatMap<Transform>((encoding) => {
    switch (encoding) {
      case "identity":
        return [];
      case "gzip":
      case "x-gzip":
        return [createGunzip()];
      case "deflate":
        return [new DeflateDecoder()];
      case "br":
        return [createBrotliDecompress()];
      default:
        throw new Error(`Unsupported HTTP content encoding: ${encoding}`);
    }
  });
  if (decoders.length) {
    // readResponseBody 的限额针对解压后的字节，不能把 wire length 当正文长度。
    headers.delete("content-length");
    headers.delete("content-encoding");
  }
  const body = new PassThrough();
  // pipeline 将解码失败/abort/cancel 传播至整个链，避免后台 socket 或未处理 error。
  void pipeline([message, ...decoders, body], { signal }).catch(() => undefined);
  return {
    status,
    statusText,
    headers,
    body: Readable.toWeb(body) as ReadableStream<Uint8Array>,
  };
}
