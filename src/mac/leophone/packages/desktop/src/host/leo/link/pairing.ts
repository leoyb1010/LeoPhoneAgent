import http from "node:http";
import https from "node:https";

import { tailnetLookup } from "./relayLink.js";

/**
 * [leo-link] Mac 出配对码:手机扫码,用一次性码向中继换一把自己的设备钥匙。
 *
 * 以前加手机要在 Mac 上 `cat ~/.leoagent/key` 再粘到手机里,全家共用一把,丢了全断;
 * 现在每台手机各领各的,互不影响。码的格式与 iPhone / 安卓 / 鸿蒙已有的扫码入口一致
 * (`leoagent-body:v2|{apiRoot, machine, join, exp}`),手机端不用改。
 *
 * 中继 0.1 与 0.2 都支持:0.2 里机器钥匙签的码默认要 Mac 二次确认,但现在的 iOS
 * 还不会轮询待定状态,所以明确要「兑换即发钥匙」的码(kind=legacy);码 5 分钟过期、只能用一次。
 */
export const PAIR_PREFIX_V2 = "leoagent-body:v2|";

export type PairingCode = {
  /** 放进二维码的整串文字。 */
  payload: string;
  machine: string;
  /** 过期时间(秒,Unix)。 */
  exp: number;
  apiRoot: string;
};

type RelayResponse = { status: number; body: Record<string, unknown> };

/** `~/.leoagent/relay.json` 里的地址(可能写成 wss://… 或带 /relay/agent)→ 中继的 https 根。 */
export function relayHttpBase(url: string): string {
  return url
    .trim()
    .replace(/\/+$/, "")
    .replace(/^wss:\/\//i, "https://")
    .replace(/^ws:\/\//i, "http://")
    .replace(/\/relay\/(agent|api)$/, "");
}

export function encodePairPayload(code: { apiRoot: string; machine: string; join: string; exp: number }): string {
  return PAIR_PREFIX_V2 + JSON.stringify({ apiRoot: code.apiRoot, machine: code.machine, join: code.join, exp: code.exp });
}

export function relayRequest(
  base: string,
  method: string,
  path: string,
  key: string,
  body?: unknown,
  timeoutMs = 12_000,
): Promise<RelayResponse> {
  const url = new URL(base + path);
  const client = url.protocol === "https:" ? https : http;
  const payload = body === undefined ? undefined : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = client.request(
      url,
      {
        method,
        headers: {
          accept: "application/json",
          authorization: `Bearer ${key}`,
          ...(payload ? { "content-type": "application/json", "content-length": Buffer.byteLength(payload) } : {}),
        },
        // 与常驻连接同一套解析:*.ts.net 走 Tailscale DNS,不被代理的假 IP 绕远。
        lookup: tailnetLookup(),
        timeout: timeoutMs,
      },
      (res) => {
        let raw = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => {
          raw += chunk;
          if (raw.length > 1_000_000) req.destroy(new Error("relay response too large"));
        });
        res.on("end", () => {
          let parsed: unknown = {};
          try {
            parsed = raw ? JSON.parse(raw) : {};
          } catch {
            parsed = {};
          }
          resolve({
            status: res.statusCode ?? 0,
            body: parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {},
          });
        });
      },
    );
    req.on("timeout", () => req.destroy(new Error("连中继超时")));
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

export type PairingSupport = "supported" | "unsupported" | "unknown";

/**
 * 中继支不支持出码:不带钥匙 POST 一次 join-tokens。有这个接口的中继回 401/403(不会签发任何码),
 * 2026-08 之前的老中继没有这个接口,回 404。网络问题等说不准的情况记 unknown,允许用户点了再说。
 */
export async function probePairingSupport(
  relayUrl: string,
  request: typeof relayRequest = relayRequest,
): Promise<PairingSupport> {
  try {
    const res = await request(relayHttpBase(relayUrl), "POST", "/relay/api/join-tokens", "", {});
    if (res.status === 404 || res.status === 405) return "unsupported";
    if (res.status === 401 || res.status === 403) return "supported";
    return "unknown";
  } catch {
    return "unknown";
  }
}

/**
 * 向中继要一个一次性码。钥匙按顺序试:机器专属钥匙(0.2 钉扎后才有)→ relay.json 里的钥匙
 * (0.1 的主钥匙;0.2 轮换前的主钥匙)。只有 401/403 才换下一把,别的错误直接报。
 */
export async function createPairingCode(args: {
  relayUrl: string;
  machine: string;
  keys: readonly string[];
  request?: typeof relayRequest;
}): Promise<PairingCode> {
  const base = relayHttpBase(args.relayUrl);
  const send = args.request ?? relayRequest;
  let rejected = false;
  for (const key of args.keys) {
    if (!key) continue;
    const res = await send(base, "POST", "/relay/api/join-tokens", key, { machine: args.machine, kind: "legacy" });
    if (res.status === 401 || res.status === 403) {
      rejected = true;
      continue;
    }
    if (res.status === 404 || res.status === 405) {
      throw new Error("中继版本太旧,还不支持扫码配对:把中继升级到 0.2 后再试");
    }
    if (res.status < 200 || res.status >= 300) throw new Error(`中继没有签发配对码(HTTP ${res.status})`);
    const token = typeof res.body["token"] === "string" ? res.body["token"] : "";
    const exp = Number(res.body["exp"] ?? 0);
    if (!token || !Number.isFinite(exp) || exp <= 0) throw new Error("中继返回的配对码不完整");
    const machine = typeof res.body["machine"] === "string" && res.body["machine"] ? res.body["machine"] : args.machine;
    const apiRoot = `${base}/relay/api`;
    return { payload: encodePairPayload({ apiRoot, machine, join: token, exp }), machine, exp, apiRoot };
  }
  throw new Error(rejected ? "中继不认这台 Mac 的钥匙,签发不了配对码" : "这台 Mac 还没有中继钥匙");
}
