// [leo] 本机接口的通用小件:错误类型、常数时间比对、路径参数解码、JSON 正文读取(从 httpApi.ts 拆出,控制文件长度)。
import { createHash, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";

/** 订阅代理的长上下文也远到不了这个量;超了直接 413,不给本机进程拿大包拖垮 Host 的机会。 */
const MAX_BODY_BYTES = 8 * 1024 * 1024;

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** 常数时间比对:先各自哈希成等长,再 timingSafeEqual,长度差也不泄露。 */
export function secretMatcher(secret: string): (candidate: string | undefined) => boolean {
  const expected = createHash("sha256").update(secret).digest();
  return (candidate) =>
    secret.length > 0 &&
    timingSafeEqual(
      createHash("sha256")
        .update(candidate ?? "")
        .digest(),
      expected,
    );
}

/** 路径里的 id:`%` 转义写坏了回 400,不要变成 500 和一条告警。 */
export function decodeParam(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new HttpError(400, "bad path parameter");
  }
}

/** 按 Buffer 收齐再一次性解码:逐块 `raw += chunk` 会把跨块的多字节中文切成 U+FFFD。 */
export function readJsonBody(
  req: IncomingMessage,
  limit = MAX_BODY_BYTES,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    req.on("data", (chunk: Buffer) => {
      if (settled) return;
      size += chunk.length;
      if (size > limit) {
        fail(new HttpError(413, "request body too large"));
        req.resume();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (settled) return;
      settled = true;
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) {
        resolve({});
        return;
      }
      try {
        const parsed: unknown = JSON.parse(raw);
        resolve(
          parsed && typeof parsed === "object" && !Array.isArray(parsed)
            ? (parsed as Record<string, unknown>)
            : {},
        );
      } catch {
        reject(new HttpError(400, "invalid JSON body"));
      }
    });
    req.on("aborted", () => fail(new HttpError(400, "request aborted")));
    req.on("error", (error) => fail(error));
  });
}
