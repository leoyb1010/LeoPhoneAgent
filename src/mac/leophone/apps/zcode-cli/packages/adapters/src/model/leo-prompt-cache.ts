// ============================================================
// [leo] OpenAI 系 prompt cache：会话级 prompt_cache_key + 非标准缓存命中字段
// ============================================================
// 1. prompt_cache_key：OpenAI（Chat Completions / Responses）按 key 把同前缀请求路由到同一缓存
//    分片。同一会话的请求带同一个 key，命中率明显更高。key 由请求头 x-session-id（runner 已按会话
//    写入，见 runner-attribution.ts）派生：sha256 截断，不把会话 id 原样发给 provider。
//    开关来自 Leo 档位的 promptCacheKey（bootstrap 把合并后的档位以 ZCODE_LEO_AGENT 注入 adapter env）：
//      - true：所有 OpenAI 系 provider 都带；
//      - false：都不带；
//      - 未设置（默认）：只对确认接受该字段的端点带（api.openai.com、openrouter.ai），
//        避免严格校验参数的兼容网关因为未知字段直接 400。
//    请求体里已有 prompt_cache_key 时不覆盖。
// 2. 缓存命中数：AI SDK 的 openai-compatible 只认 prompt_tokens_details.cached_tokens；DeepSeek 用
//    prompt_cache_hit_tokens、Moonshot/Kimi 用顶层 cached_tokens。convertLeoOpenAICompatibleUsage
//    补上这些回退，命中数进入 ModelUsage.cacheReadTokens，沿既有 usage 链路到事件 / CLI 输出。

import { createHash } from "node:crypto";
import type { createOpenAICompatible } from "@ai-sdk/openai-compatible";

type ProviderFetch = typeof globalThis.fetch;
type EnvRecord = Record<string, string | undefined>;
type OpenAICompatibleUsageConverter = NonNullable<
  NonNullable<Parameters<typeof createOpenAICompatible>[0]>["convertUsage"]
>;

const SESSION_HEADER = "x-session-id";
const LEO_AGENT_ENV_KEY = "ZCODE_LEO_AGENT";
const PROMPT_CACHE_KEY_FIELD = "prompt_cache_key";
const PROMPT_CACHE_KEY_PREFIX = "leo-";
const PROMPT_CACHE_KEY_HASH_LENGTH = 32;
const DEFAULT_PROMPT_CACHE_KEY_HOSTS: readonly string[] = ["api.openai.com", "openrouter.ai"];

export type LeoPromptCacheKeyMode = "on" | "off" | "auto";

export function resolveLeoPromptCacheKeyMode(env: EnvRecord): LeoPromptCacheKeyMode {
  const raw = env[LEO_AGENT_ENV_KEY]?.trim();
  if (!raw) return "auto";
  try {
    const parsed: unknown = JSON.parse(raw);
    const value =
      typeof parsed === "object" && parsed !== null
        ? (parsed as { promptCacheKey?: unknown }).promptCacheKey
        : undefined;
    if (value === true) return "on";
    if (value === false) return "off";
  } catch {
    // 非法 JSON 由 bootstrap 记 warning；这里按默认处理
  }
  return "auto";
}

export function shouldSendLeoPromptCacheKey(
  mode: LeoPromptCacheKeyMode,
  baseURL: string | undefined,
): boolean {
  if (mode !== "auto") return mode === "on";
  if (!baseURL) return false;
  try {
    const host = new URL(baseURL).hostname.toLowerCase();
    return DEFAULT_PROMPT_CACHE_KEY_HOSTS.some(
      (allowed) => host === allowed || host.endsWith(`.${allowed}`),
    );
  } catch {
    return false;
  }
}

export function leoPromptCacheKeyForSession(sessionId: string): string {
  const digest = createHash("sha256").update(`leo-prompt-cache:${sessionId}`).digest("hex");
  return `${PROMPT_CACHE_KEY_PREFIX}${digest.slice(0, PROMPT_CACHE_KEY_HASH_LENGTH)}`;
}

export function createLeoPromptCacheKeyFetch(input: {
  readonly fetch: ProviderFetch;
  readonly enabled: boolean;
}): ProviderFetch {
  if (!input.enabled) return input.fetch;
  return async (request, init) => {
    const sessionId = readHeader(request, init, SESSION_HEADER);
    const bodyText =
      typeof init?.body === "string"
        ? init.body
        : init?.body === undefined && request instanceof Request
          ? await request.clone().text()
          : undefined;
    if (!sessionId || !bodyText) return input.fetch(request, init);

    let body: unknown;
    try {
      body = JSON.parse(bodyText);
    } catch {
      return input.fetch(request, init);
    }
    if (
      typeof body !== "object" ||
      body === null ||
      Array.isArray(body) ||
      PROMPT_CACHE_KEY_FIELD in body ||
      !("messages" in body || "input" in body)
    ) {
      return input.fetch(request, init);
    }

    const patchedBody = JSON.stringify({
      ...(body as Record<string, unknown>),
      [PROMPT_CACHE_KEY_FIELD]: leoPromptCacheKeyForSession(sessionId),
    });
    if (request instanceof Request) {
      return input.fetch(new Request(request, { ...init, body: patchedBody }));
    }
    return input.fetch(request, { ...init, body: patchedBody });
  };
}

function readHeader(
  request: RequestInfo | URL,
  init: RequestInit | undefined,
  name: string,
): string | undefined {
  const fromInit = init?.headers ? new Headers(init.headers).get(name) : null;
  if (fromInit) return fromInit;
  return request instanceof Request ? (request.headers.get(name) ?? undefined) : undefined;
}

// -----------------------------------------------
// openai-compatible usage：补非标准的缓存命中字段
// -----------------------------------------------

export const convertLeoOpenAICompatibleUsage: OpenAICompatibleUsageConverter = (usage) => {
  if (usage === undefined || usage === null) {
    return {
      inputTokens: { total: undefined, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
      outputTokens: { total: undefined, text: undefined, reasoning: undefined },
      raw: undefined,
    };
  }
  const record = usage as Record<string, unknown>;
  const promptDetails = asRecord(record.prompt_tokens_details);
  const completionDetails = asRecord(record.completion_tokens_details);
  const promptTokens = asNumber(record.prompt_tokens) ?? 0;
  const completionTokens = asNumber(record.completion_tokens) ?? 0;
  const cacheReadTokens =
    asNumber(promptDetails?.cached_tokens) ??
    asNumber(record.prompt_cache_hit_tokens) ??
    asNumber(record.cached_tokens) ??
    0;
  const cacheWriteTokens =
    asNumber(promptDetails?.cache_write_tokens) ?? asNumber(promptDetails?.cache_creation_tokens);
  const reasoningTokens = asNumber(completionDetails?.reasoning_tokens) ?? 0;
  return {
    inputTokens: {
      total: promptTokens,
      noCache: promptTokens - cacheReadTokens,
      cacheRead: cacheReadTokens,
      cacheWrite: cacheWriteTokens,
    },
    outputTokens: {
      total: completionTokens,
      text: completionTokens - reasoningTokens,
      reasoning: reasoningTokens,
    },
    raw: usage as unknown as ReturnType<OpenAICompatibleUsageConverter>["raw"],
  };
};

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
