import { createHmac } from "node:crypto";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

/**
 * [leo][WP-51] 看屏 R1 的 ICE 规则(契约见 docs/specs/leo-screen.md「R1」)。
 *
 * 路径优先级:tailnet(100.64/10、fd7a:115c:a1e0::/48)→ 局域网 → STUN 反射 → Mac mini coturn 中转。
 * Mac 是应答方(被控方),对端(iPhone,控制方)按候选优先级配对提名,所以这里把应答 SDP 里本机候选的
 * priority 按上面的档位重写并排序;「只走 tailnet」打开时只留 tailnet 候选,对端发来的非 tailnet 候选也丢掉。
 */

type CandidateTier = "tailnet" | "lan" | "srflx" | "relay" | "other";

const TIER_TYPE_PREFERENCE: Record<CandidateTier, number> = {
  tailnet: 126,
  lan: 110,
  other: 100,
  srflx: 90,
  relay: 10,
};

function ipv4Number(address: string): number | null {
  const parts = address.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255))
    return null;
  return ((parts[0]! << 24) >>> 0) + (parts[1]! << 16) + (parts[2]! << 8) + parts[3]!;
}

function inV4(address: number, base: string, bits: number): boolean {
  const start = ipv4Number(base)!;
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
  return (address & mask) >>> 0 === (start & mask) >>> 0;
}

/** 按地址分档;typ 是 SDP 候选里的类型(host / srflx / prflx / relay)。 */
export function candidateTier(address: string, type: string): CandidateTier {
  if (type === "relay") return "relay";
  const v4 = ipv4Number(address);
  if (v4 !== null) {
    if (inV4(v4, "100.64.0.0", 10)) return "tailnet";
    if (
      inV4(v4, "10.0.0.0", 8) ||
      inV4(v4, "172.16.0.0", 12) ||
      inV4(v4, "192.168.0.0", 16) ||
      inV4(v4, "169.254.0.0", 16)
    )
      return "lan";
    return type === "srflx" || type === "prflx" ? "srflx" : "other";
  }
  const lower = address.toLowerCase();
  if (lower.startsWith("fd7a:115c:a1e0:")) return "tailnet";
  if (/^f[cd][0-9a-f]{2}:/.test(lower) || /^fe[89ab][0-9a-f]:/.test(lower)) return "lan";
  return type === "srflx" || type === "prflx" ? "srflx" : "other";
}

interface ParsedCandidate {
  foundation: string;
  component: string;
  transport: string;
  priority: number;
  address: string;
  port: string;
  type: string;
  rest: string[];
}

/** 解析 `candidate:...` 或 `a=candidate:...`;不认识的格式返回 null。 */
function parseCandidate(line: string): ParsedCandidate | null {
  const body = line.replace(/^a=/, "").replace(/^candidate:/, "");
  const parts = body.trim().split(/\s+/);
  if (parts.length < 8 || parts[6] !== "typ") return null;
  const priority = Number(parts[3]);
  if (!Number.isFinite(priority)) return null;
  return {
    foundation: parts[0]!,
    component: parts[1]!,
    transport: parts[2]!,
    priority,
    address: parts[4]!,
    port: parts[5]!,
    type: parts[7]!,
    rest: parts.slice(8),
  };
}

function formatCandidate(candidate: ParsedCandidate): string {
  return [
    `candidate:${candidate.foundation}`,
    candidate.component,
    candidate.transport,
    String(candidate.priority),
    candidate.address,
    candidate.port,
    "typ",
    candidate.type,
    ...candidate.rest,
  ].join(" ");
}

/** RFC 8445 公式:类型偏好 × 2^24 + 本地偏好 × 2^8 + (256 − 组件号);同档里 UDP 先于 TCP。 */
function rankedPriority(candidate: ParsedCandidate, tier: CandidateTier): number {
  const localPreference = candidate.transport.toLowerCase() === "udp" ? 65_535 : 32_767;
  const component = Number(candidate.component) || 1;
  return TIER_TYPE_PREFERENCE[tier] * 2 ** 24 + localPreference * 2 ** 8 + (256 - component);
}

/** Chromium 默认把本机地址藏成 `<uuid>.local`(mDNS)。tailnet 上没有 mDNS,对端解析不了,先换回真地址。 */
export type Resolver = (hostname: string) => Promise<string | null>;

const resolveLocalName: Resolver = async (hostname) => {
  try {
    return (await lookup(hostname)).address;
  } catch {
    return null;
  }
};

interface RankOptions {
  tailnetOnly: boolean;
  resolve?: Resolver;
}

/**
 * 重写应答 SDP 里的本机候选:mDNS 名换真地址、按档位重算 priority 并排序、「只走 tailnet」时只留 tailnet。
 * 返回新 SDP 与留下的候选档位(给统计 / 日志)。
 */
export async function rankAnswerCandidates(
  sdp: string,
  options: RankOptions,
): Promise<{ sdp: string; tiers: CandidateTier[] }> {
  const resolve = options.resolve ?? resolveLocalName;
  const eol = sdp.includes("\r\n") ? "\r\n" : "\n";
  const lines = sdp.split(/\r?\n/);
  const out: string[] = [];
  const tiers: CandidateTier[] = [];
  let index = 0;
  while (index < lines.length) {
    if (!lines[index]!.startsWith("a=candidate:")) {
      out.push(lines[index]!);
      index += 1;
      continue;
    }
    // 一个 m= 段里的候选是连续的几行:整块取出来排序后放回原位。
    const block: { candidate: ParsedCandidate; tier: CandidateTier }[] = [];
    while (index < lines.length && lines[index]!.startsWith("a=candidate:")) {
      const parsed = parseCandidate(lines[index]!);
      index += 1;
      if (!parsed) continue;
      if (parsed.address.endsWith(".local")) {
        const address = await resolve(parsed.address);
        if (!address || !isIP(address)) continue;
        parsed.address = address;
      }
      const tier = candidateTier(parsed.address, parsed.type);
      if (options.tailnetOnly && tier !== "tailnet") continue;
      parsed.priority = rankedPriority(parsed, tier);
      block.push({ candidate: parsed, tier });
    }
    block.sort((a, b) => b.candidate.priority - a.candidate.priority);
    for (const { candidate, tier } of block) {
      out.push(`a=${formatCandidate(candidate)}`);
      tiers.push(tier);
    }
  }
  return { sdp: out.join(eol), tiers };
}

export interface RemoteCandidate {
  candidate: string;
  sdpMid?: string | null;
  sdpMLineIndex?: number | null;
}

/** 对端 trickle 来的候选:格式不对的丢掉;「只走 tailnet」时只放 tailnet 的(mDNS 名在 tailnet 上不可能解析,也丢)。 */
export function acceptRemoteCandidate(candidate: RemoteCandidate, tailnetOnly: boolean): boolean {
  // 空串是「收集结束」标记,照转。
  if (candidate.candidate === "") return true;
  const parsed = parseCandidate(candidate.candidate);
  if (!parsed) return false;
  if (!tailnetOnly) return true;
  return candidateTier(parsed.address, parsed.type) === "tailnet";
}

/** 对端 offer 里自带的候选(非 trickle 时):同样按「只走 tailnet」过滤。 */
export function filterOfferCandidates(sdp: string, tailnetOnly: boolean): string {
  if (!tailnetOnly) return sdp;
  const eol = sdp.includes("\r\n") ? "\r\n" : "\n";
  return sdp
    .split(/\r?\n/)
    .filter((line) => {
      if (!line.startsWith("a=candidate:")) return true;
      const parsed = parseCandidate(line);
      return parsed !== null && candidateTier(parsed.address, parsed.type) === "tailnet";
    })
    .join(eol);
}

interface TurnConfig {
  urls: string[];
  /** coturn `static-auth-secret`;Mac 用它签短期账号(TURN REST),手机拿不到它本身。 */
  secret: string;
  ttlSeconds: number;
}

interface IceServer {
  urls: string[];
  username?: string;
  credential?: string;
}

/** coturn use-auth-secret 的短期凭据:username = "<过期 unix 秒>:leobot",credential = base64(HMAC-SHA1)。 */
export function turnIceServers(config: TurnConfig | null, nowMs: number): IceServer[] {
  if (!config || config.urls.length === 0) return [];
  const expiry = Math.floor(nowMs / 1000) + config.ttlSeconds;
  const username = `${expiry}:leobot`;
  const credential = createHmac("sha1", config.secret).update(username).digest("base64");
  const stun = config.urls.filter((url) => url.startsWith("stun:"));
  const turn = config.urls.filter((url) => !url.startsWith("stun:"));
  return [
    ...(stun.length ? [{ urls: stun }] : []),
    ...(turn.length ? [{ urls: turn, username, credential }] : []),
  ];
}

export function parseTurnConfig(raw: unknown): TurnConfig | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Record<string, unknown>;
  const urls = Array.isArray(value["urls"])
    ? value["urls"].filter(
        (url): url is string => typeof url === "string" && /^(stun|turns?):[^\s]+$/.test(url),
      )
    : [];
  const secret = typeof value["secret"] === "string" ? value["secret"] : "";
  const ttl = Number(value["ttl_seconds"]);
  if (urls.length === 0 || (urls.some((url) => !url.startsWith("stun:")) && secret.length < 16))
    return null;
  return {
    urls,
    secret,
    ttlSeconds: Number.isFinite(ttl) ? Math.min(86_400, Math.max(300, Math.round(ttl))) : 3_600,
  };
}
