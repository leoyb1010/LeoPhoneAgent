import type { LinkResponse } from "./bridge.js";
import { error as failure } from "./linkPolicy.js";
import type { Caller } from "./session.js";

const FORWARD_TIMEOUT_MS = 55_000;

export type LeoagentEndpoint = { url: string; key: () => string | null };

/**
 * [leo-link] claude / codex / grok 会话跑在本机 leoagent(Python,:8646)里,桥接原样转过去:
 * 普通请求一问一答;事件流逐帧剥掉 SSE 的 "data: " 交给中继。
 */
export class LeoagentForwarder {
  constructor(private readonly endpoint: LeoagentEndpoint) {}

  private headers(extra: Record<string, string> = {}): Record<string, string> | null {
    const key = this.endpoint.key();
    return key ? { Authorization: `Bearer ${key}`, ...extra } : null;
  }

  /** `caller`:手机这一端的调用方类别,leoagent 据此决定能不能开全自动(本机直调不带)。 */
  async request(method: string, tail: string, body?: unknown, caller?: Caller): Promise<LinkResponse> {
    const headers = this.headers({
      ...(body != null ? { "Content-Type": "application/json" } : {}),
      ...(caller ? { "X-Leo-Caller-Kind": caller.kind } : {}),
    });
    if (!headers) return failure(503, "本机 leoagent 未配置");
    try {
      const res = await fetch(`${this.endpoint.url}${tail}`, {
        method,
        headers,
        body: body != null ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(FORWARD_TIMEOUT_MS),
      });
      const text = await res.text();
      let payload: unknown;
      try {
        payload = JSON.parse(text);
      } catch {
        payload = { raw: text };
      }
      return { status: res.status, body: payload };
    } catch (cause) {
      return failure(502, `本机 leoagent 不可用:${cause instanceof Error ? cause.message : String(cause)}`);
    }
  }

  async stream(tail: string, write: (data: string) => void, signal: AbortSignal): Promise<void> {
    const headers = this.headers({ Accept: "text/event-stream" });
    if (!headers) return;
    try {
      const res = await fetch(`${this.endpoint.url}${tail}`, { headers, signal });
      if (!res.body) return;
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffered = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffered += decoder.decode(value, { stream: true });
        let newline = buffered.indexOf("\n");
        while (newline !== -1) {
          const line = buffered.slice(0, newline).trim();
          buffered = buffered.slice(newline + 1);
          // 本机是 SSE 帧,剥掉 "data: " 交给中继;注释保活跳过。
          if (line.startsWith("data:")) write(line.slice(5).trim());
          newline = buffered.indexOf("\n");
        }
      }
    } catch {
      // 手机断开或 leoagent 重启:手机会按 seq 续传。
    }
  }
}
