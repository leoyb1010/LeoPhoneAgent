import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { ZCODE_VERSION } from "@zcode/shared";

/**
 * [leo] Host 侧的第二大脑网关只读客户端(用户画像同步、首页「大脑」卡片)。
 *
 * 和 leo-brain MCP(packages/desktop/leo/brain-mcp.mjs)用同一把本机 key、同一个网关;
 * key 只放进 Authorization 头,不进日志、不进返回值。Cloudflare 会拦掉 Node fetch 默认的
 * User-Agent,所以每个请求都带一个正常的 UA。
 */

export const BRAIN_GATEWAY_URL = "https://wenjian.leoyuan.top";
const REQUEST_TIMEOUT_MS = 20_000;

export function defaultBrainKeyFile(home: string = homedir()): string {
  return join(home, ".config", "leo-brain", "leobot-mac.key");
}

export type BrainFetch = (url: string, init: RequestInit) => Promise<Response>;

export class BrainHttpError extends Error {
  constructor(
    readonly status: number,
    path: string,
  ) {
    super(`brain gateway ${path} → HTTP ${status}`);
  }
}

export interface BrainGateway {
  /** 2xx 返回 JSON;404 返回 null;其余状态和网络错误抛出。 */
  getJson(path: string, params?: Record<string, string | number>): Promise<unknown>;
}

/** 本机没发 key(文件不存在或为空)就返回 null:调用方据此整块跳过。 */
export async function openBrainGateway(
  options: { keyFile?: string; baseUrl?: string; fetch?: BrainFetch } = {},
): Promise<BrainGateway | null> {
  let key: string;
  try {
    key = (await readFile(options.keyFile ?? defaultBrainKeyFile(), "utf8")).trim();
  } catch {
    return null;
  }
  if (!key) return null;
  const base = (options.baseUrl ?? process.env["LEO_BRAIN_URL"] ?? BRAIN_GATEWAY_URL).replace(/\/+$/, "");
  const doFetch: BrainFetch = options.fetch ?? ((url, init) => fetch(url, init));
  const userAgent = `LeoBotMac/${ZCODE_VERSION} leo-host`;
  return {
    async getJson(path, params) {
      const query = new URLSearchParams();
      for (const [name, value] of Object.entries(params ?? {})) query.append(name, String(value));
      const url = `${base}${path}${query.size > 0 ? `?${query}` : ""}`;
      const response = await doFetch(url, {
        method: "GET",
        headers: { Authorization: `Bearer ${key}`, "User-Agent": userAgent, Accept: "application/json" },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (response.status === 404) return null;
      if (!response.ok) throw new BrainHttpError(response.status, path);
      return (await response.json()) as unknown;
    },
  };
}

export interface BrainStatus {
  /** false = 本机没有 key,界面整块隐藏。 */
  enabled: boolean;
  cards: number | null;
  files: number | null;
  error?: string;
}

const STATUS_TTL_MS = 5 * 60_000;
let statusCache: { at: number; value: BrainStatus } | null = null;

/** 首页「大脑」卡片:网关 /v1/health 的卡片数 / 文件数。缓存 5 分钟,首页反复打开不重复打网关。 */
export async function readBrainStatus(
  options: { keyFile?: string; fetch?: BrainFetch; now?: () => number } = {},
): Promise<BrainStatus> {
  const now = options.now?.() ?? Date.now();
  if (statusCache && now - statusCache.at < STATUS_TTL_MS) return statusCache.value;
  const gateway = await openBrainGateway(options);
  let value: BrainStatus;
  if (!gateway) {
    value = { enabled: false, cards: null, files: null };
  } else {
    try {
      const health = (await gateway.getJson("/v1/health")) as {
        archive?: { cards?: unknown; files?: unknown };
      } | null;
      const count = (raw: unknown) => (typeof raw === "number" && Number.isFinite(raw) ? raw : null);
      value = { enabled: true, cards: count(health?.archive?.cards), files: count(health?.archive?.files) };
    } catch (error) {
      // 出错不缓存太久:下一次打开首页再试。
      const message = error instanceof BrainHttpError ? `HTTP ${error.status}` : "unreachable";
      return { enabled: true, cards: null, files: null, error: message };
    }
  }
  statusCache = { at: now, value };
  return value;
}

export function resetBrainStatusCacheForTests(): void {
  statusCache = null;
}
