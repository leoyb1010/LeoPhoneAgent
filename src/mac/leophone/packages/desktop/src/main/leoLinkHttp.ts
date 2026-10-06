import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type LeoLinkIpcResult<T = Record<string, unknown>> =
  | { ok: true; data: T }
  | { ok: false; error: string };

// 与 host/leo/leoPaths.ts 同一套约定(主进程不引 host 的模块):端口 38473,钥匙 ~/.leoagent/key。
export const LEO_HTTP_PORT = Number(process.env["LEOAGENT_PORT"]) || 38473;

function leoLocalKey(): string | null {
  const envKey = process.env["LEOAGENT_KEY"]?.trim();
  if (envKey) return envKey;
  const home = process.env["LEOAGENT_HOME"]?.trim() || join(homedir(), ".leoagent");
  try {
    const key = readFileSync(join(home, "key"), "utf8").trim();
    return key.length >= 16 ? key : null;
  } catch {
    return null;
  }
}

export async function callLeo(
  path: string,
  method: "GET" | "POST" | "DELETE",
  extraHeaders: Record<string, string> = {},
  body?: unknown,
): Promise<LeoLinkIpcResult> {
  const key = leoLocalKey();
  if (!key) return { ok: false, error: "本机 Leo 服务还没启动" };
  try {
    const res = await fetch(`http://127.0.0.1:${LEO_HTTP_PORT}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${key}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        ...extraHeaders,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(25_000),
    });
    // 不能叫 body:同一块里先用了参数 body,const 会让它落进暂时性死区,每次调用都抛 ReferenceError。
    const payload = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      return {
        ok: false,
        error: typeof payload["error"] === "string" ? payload["error"] : `HTTP ${res.status}`,
      };
    }
    return { ok: true, data: payload };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * 38473 上的是不是我们自己的 Host。保留的 LeoCodeBox 2.x 或别的程序占着端口时,
 * 出码口令不能交给它(口令只该出现在主进程和我们的 Host 之间)。
 */
export async function ownHostListening(): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${LEO_HTTP_PORT}/api/leo/health`, {
      signal: AbortSignal.timeout(5_000),
    });
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    return body["app"] === "leophoneagent-1.x";
  } catch {
    return false;
  }
}

/** 订阅登录页地址:口令放在片段里,不发给服务器、不进访问日志;端口按本机实际配置。 */
export function leoOAuthPageUrl(port: number, secret: string): string {
  return `http://127.0.0.1:${port}/leo/oauth#t=${encodeURIComponent(secret)}`;
}
