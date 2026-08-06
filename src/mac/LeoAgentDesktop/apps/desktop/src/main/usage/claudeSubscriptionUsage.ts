/**
 * claudeSubscriptionUsage(main)— 拉取 Claude 订阅账号余量的 HTTP 层。
 *
 * 端点:GET https://api.anthropic.com/api/oauth/usage(未文档化;Claude Code /usage
 * 命令同源,社区工具 CodexBar / OpenUsage 长期在用)。要求:
 *   - `Authorization: Bearer <claudeAiOauth.accessToken>`(user:profile scope)
 *   - `anthropic-beta: oauth-2025-04-20`(缺了 401)
 *   - `User-Agent: claude-code/<version>`(缺了会落进激进限流桶,持续 429;版本号
 *     取应用实际分发的 claude 二进制版本,拿不到用 pin 兜底)
 *
 * 错误语义(供 claudeSubscriptionUsageRefresh 的 reader 消费):
 *   - 401 / 403 → ClaudeSubscriptionUsageUnauthorizedError(token 失效,清缓存快照)
 *   - 429       → ClaudeSubscriptionUsageRateLimitedError(退避,保留缓存快照)
 *   - 其它失败  → null(保留缓存,下轮再试)
 */

import { createLogger } from '../logger.js';
import {
  parseClaudeOAuthUsageResponse,
  type ClaudeSubscriptionUsageSnapshot,
} from '../../shared/claudeSubscriptionUsage.js';

const log = createLogger('usage:claude-subscription');

const CLAUDE_OAUTH_USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const CLAUDE_OAUTH_USAGE_TIMEOUT_MS = 5000;
/** UA 版本兜底 —— 与 tools/claude/latest.json 的 pin 同步升级无强要求,仅限流桶分流用。 */
const FALLBACK_CLAUDE_CODE_VERSION = '2.1.186';

export class ClaudeSubscriptionUsageUnauthorizedError extends Error {
  readonly status: number;

  constructor(status: number) {
    super(`Claude subscription usage unauthorized (${status})`);
    this.name = 'ClaudeSubscriptionUsageUnauthorizedError';
    this.status = status;
  }
}

export class ClaudeSubscriptionUsageRateLimitedError extends Error {
  constructor() {
    super('Claude subscription usage rate limited (429)');
    this.name = 'ClaudeSubscriptionUsageRateLimitedError';
  }
}

/**
 * 端点成功(2xx)但响应里解析不出任何窗口 —— 教育版 / 组织托管订阅无数字配额,
 * 或 schema 再次变化。与网络失败(null)语义不同:调用方应**清除**缓存快照让
 * chip 降级为无数据, 而不是继续展示过期值。
 */
export const CLAUDE_SUBSCRIPTION_USAGE_EMPTY = 'empty' as const;
export type ClaudeSubscriptionUsageFetchResult =
  | ClaudeSubscriptionUsageSnapshot
  | typeof CLAUDE_SUBSCRIPTION_USAGE_EMPTY
  | null;

export async function fetchClaudeSubscriptionUsageSnapshot(opts: {
  accessToken: string;
  /** 凭证 blob 的 subscriptionType(pro / max...),随快照一并落下供 tooltip 显示。 */
  subscriptionType?: string | null;
  /** 应用实际分发的 claude 二进制版本(如 '2.1.186');省略用 pin 兜底。 */
  claudeCodeVersion?: string | null;
  fetchFn?: typeof fetch;
  timeoutMs?: number;
  now?: number;
}): Promise<ClaudeSubscriptionUsageFetchResult> {
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    opts.timeoutMs ?? CLAUDE_OAUTH_USAGE_TIMEOUT_MS,
  );
  try {
    const version = opts.claudeCodeVersion?.trim() || FALLBACK_CLAUDE_CODE_VERSION;
    const res = await (opts.fetchFn ?? fetch)(CLAUDE_OAUTH_USAGE_URL, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${opts.accessToken}`,
        'anthropic-beta': 'oauth-2025-04-20',
        'User-Agent': `claude-code/${version}`,
        Accept: 'application/json',
      },
      signal: controller.signal,
    });
    if (!res.ok) {
      log.warn('claude subscription usage fetch failed', { status: res.status });
      if (res.status === 401 || res.status === 403) {
        throw new ClaudeSubscriptionUsageUnauthorizedError(res.status);
      }
      if (res.status === 429) {
        throw new ClaudeSubscriptionUsageRateLimitedError();
      }
      return null;
    }
    const data: unknown = await res.json();
    const snapshot = parseClaudeOAuthUsageResponse(data, opts.now ?? Date.now());
    if (!snapshot) {
      // 端点通了但解析不出任何窗口(schema 又变了 / 教育版无数字配额)——
      // 显式返回 'empty' 让 reader 清缓存降级为无数据, 与网络失败(null, 保留缓存)区分。
      log.warn('claude subscription usage response had no parsable windows');
      return CLAUDE_SUBSCRIPTION_USAGE_EMPTY;
    }
    return {
      ...snapshot,
      subscriptionType: opts.subscriptionType ?? null,
    };
  } catch (err) {
    if (
      err instanceof ClaudeSubscriptionUsageUnauthorizedError
      || err instanceof ClaudeSubscriptionUsageRateLimitedError
    ) {
      throw err;
    }
    log.warn('claude subscription usage fetch failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  } finally {
    clearTimeout(timeout);
  }
}
