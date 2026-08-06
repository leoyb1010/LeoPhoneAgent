/**
 * claudeSubscriptionUsageRefresh — Claude 订阅余量的 cached-first reader(纯逻辑,依赖注入)。
 *
 * 形态对齐 codexAccountUsageRefresh:IPC 读走缓存快照立即返回,慢的端点 fetch 在后台
 * 刷新共享快照(recordSnapshot 内部会广播给 renderer)。与 codex 版的差异:
 *   - 身份维度只有 access token(Claude 无 accountId 概念),token 变化即换人。
 *   - 节流默认 180s(oauth/usage 是未文档化端点,社区经验 ≥180s 缓存才稳;turn 内的
 *     实时性由 proxy 旁路读的 unified headers 兜住,端点只负责冷启动 + scoped 窗口)。
 *   - 429 显式指数退避(5min 起,×2 封顶 30min)——该端点对高频调用会持续 429。
 *
 * 另暴露 triggerRefresh() 给 turn-done 钩子做 fire-and-forget 触发(同样吃节流 / 退避)。
 */

import type { ClaudeSubscriptionUsageSnapshot } from '../../shared/claudeSubscriptionUsage.js';

export interface ClaudeSubscriptionCredentialInfo {
  accessToken: string;
  subscriptionType?: string | null;
}

interface ClaudeSubscriptionUsageRefreshDeps {
  /** 读当前 OAuth 凭证(无订阅登录 → null)。 */
  readCredentials(): ClaudeSubscriptionCredentialInfo | null;
  /**
   * 拉端点快照。返回语义:snapshot = 正常;'empty' = 端点成功但无可解析窗口
   * (教育版无数字配额 / schema 变化, 应清缓存降级为无数据);null = 网络失败等
   * (保留缓存下轮再试)。
   */
  fetchSnapshot(
    args: ClaudeSubscriptionCredentialInfo,
  ): Promise<ClaudeSubscriptionUsageSnapshot | 'empty' | null>;
  recordSnapshot(snapshot: ClaudeSubscriptionUsageSnapshot): Promise<void>;
  clearSnapshot(): Promise<void>;
  readCachedSnapshot(): Promise<ClaudeSubscriptionUsageSnapshot | null>;
  /** token → 快照归属指纹(与 record 侧同一实现);read() 用它识别换号后的过期快照。 */
  fingerprintToken(token: string): string;
  now(): number;
  isUnauthorizedError(err: unknown): boolean;
  isRateLimitedError(err: unknown): boolean;
  onRefreshError(err: unknown): void;
}

interface ClaudeSubscriptionUsageRefreshOptions {
  throttleMs?: number;
  rateLimitBackoffInitialMs?: number;
  rateLimitBackoffMaxMs?: number;
}

const DEFAULT_THROTTLE_MS = 180_000;
const DEFAULT_BACKOFF_INITIAL_MS = 5 * 60_000;
const DEFAULT_BACKOFF_MAX_MS = 30 * 60_000;

export interface ClaudeSubscriptionUsageReader {
  /** cached-first 读(IPC handler 用):立即返回缓存快照,后台按节流刷新。 */
  read(): Promise<ClaudeSubscriptionUsageSnapshot | null>;
  /** 显式触发一次后台刷新(turn-done 钩子用),同样吃节流 / 退避。 */
  triggerRefresh(): void;
  /**
   * 凭证变化(OAuth 登录 / 登出 / 换号)后的强制同步 —— 调用方保证"凭证刚发生了
   * 变化"。与 read() 的区别: 凭证为 null 时**无条件**清持久化快照并广播(read 的
   * hadCredentials 守卫会挡住"冷启动后首个操作是登出"的场景, 导致磁盘残留)。
   */
  syncForCredentialChange(): Promise<void>;
}

export function createClaudeSubscriptionUsageReader(
  deps: ClaudeSubscriptionUsageRefreshDeps,
  options: ClaudeSubscriptionUsageRefreshOptions = {},
): ClaudeSubscriptionUsageReader {
  const throttleMs = options.throttleMs ?? DEFAULT_THROTTLE_MS;
  const backoffInitialMs = options.rateLimitBackoffInitialMs ?? DEFAULT_BACKOFF_INITIAL_MS;
  const backoffMaxMs = options.rateLimitBackoffMaxMs ?? DEFAULT_BACKOFF_MAX_MS;

  let inFlight: Promise<void> | null = null;
  // in-flight fetch 归属的 token —— 换号发生在飞行中时, 旧响应会被 isRefreshStillCurrent
  // 丢弃, 必须在旧 promise 结束后为新 token 补一次刷新, 否则端点独有字段(scoped 分模型
  // 窗口 / extra usage)要空到下一次外部触发。
  let inFlightToken: string | null = null;
  // 节流 / 退避状态按 access token 记 —— token 换了(重新登录 / 换号)立即重新计。
  let stateToken: string | null = null;
  let lastRefreshAt = 0;
  let backoffMs = 0;
  let backoffUntil = 0;
  let hadCredentials = false;
  // 无凭证结果的冷却 —— readCredentials 在 macOS 是同步 keychain 子进程读, 而
  // triggerRefresh 被每个 Claude turn-done 无条件调用; 未连订阅 (gateway-only) 用户
  // 若不缓存 null 结果, 每个 turn 都要白付一次阻塞读。读到 null 后 throttleMs 内
  // 不再探测; 登录 / 登出走 auth-change 钩子与 read()(二者不吃这个冷却, 探测后
  // 按结果重置), 外部 cc CLI 登录最迟一个冷却窗口被 turn-done 拾起。
  let noCredentialsUntil = 0;

  function resetStateForToken(token: string): void {
    if (stateToken === token) return;
    stateToken = token;
    lastRefreshAt = 0;
    backoffMs = 0;
    backoffUntil = 0;
  }

  async function clearCachedSnapshot(): Promise<void> {
    stateToken = null;
    lastRefreshAt = 0;
    backoffMs = 0;
    backoffUntil = 0;
    try {
      await deps.clearSnapshot();
    } catch (err) {
      deps.onRefreshError(err);
    }
  }

  function isRefreshStillCurrent(token: string): boolean {
    try {
      return deps.readCredentials()?.accessToken === token;
    } catch (err) {
      deps.onRefreshError(err);
      return false;
    }
  }

  function triggerRefreshWith(credentials: ClaudeSubscriptionCredentialInfo): Promise<void> {
    if (inFlight) {
      // 飞行中的 fetch 属于另一个 token(换号):等旧请求收尾后按当时最新凭证补一次
      // 刷新(旧响应会被 isRefreshStillCurrent 丢弃)。同 token 直接复用旧 promise。
      if (inFlightToken !== credentials.accessToken) {
        return inFlight.finally(() => {
          const current = readCredentialsSafe();
          if (current) void triggerRefreshWith(current);
        });
      }
      return inFlight;
    }

    resetStateForToken(credentials.accessToken);
    const now = deps.now();
    if (now < backoffUntil) return Promise.resolve();
    if (lastRefreshAt > 0 && now - lastRefreshAt < throttleMs) return Promise.resolve();

    lastRefreshAt = now;
    inFlightToken = credentials.accessToken;
    inFlight = (async () => {
      try {
        const result = await deps.fetchSnapshot(credentials);
        backoffMs = 0;
        backoffUntil = 0;
        if (!isRefreshStillCurrent(credentials.accessToken)) return;
        if (result === 'empty') {
          // 端点成功但无可解析窗口 —— 清缓存让 chip 降级为无数据, 不展示过期值。
          // 注意只清快照、**不**动节流 / 退避状态(clearCachedSnapshot 会重置
          // stateToken, 教育版账号会退化成每次 turn-done 都打一次端点)。
          await deps.clearSnapshot();
          return;
        }
        if (result) {
          // 归属指纹在这里附加 —— fetch 时 token 已在手, 不需要 record 侧再读凭证库
          // (headers 旁路源不附指纹, merge 时沿用本端点源写入的值)。
          await deps.recordSnapshot({
            ...result,
            accountFingerprint: deps.fingerprintToken(credentials.accessToken),
          });
        }
      } catch (err) {
        if (deps.isUnauthorizedError(err)) {
          if (isRefreshStillCurrent(credentials.accessToken)) {
            // 只清快照, **保留**节流 / 退避状态 —— token 过期但仍在凭证库的窗口里
            // (cc 尚未刷新写回), clearCachedSnapshot 的全重置会让每个 turn-done 都
            // 无节流重试这个敏感端点; 节流保留后 180s 内不再打, cc 刷新出新 token
            // 时 stateToken 变化自然重置节流恢复正常。
            try {
              await deps.clearSnapshot();
            } catch (clearErr) {
              deps.onRefreshError(clearErr);
            }
          }
          return;
        }
        if (deps.isRateLimitedError(err)) {
          backoffMs = backoffMs > 0 ? Math.min(backoffMs * 2, backoffMaxMs) : backoffInitialMs;
          backoffUntil = deps.now() + backoffMs;
          return;
        }
        deps.onRefreshError(err);
      } finally {
        inFlight = null;
        inFlightToken = null;
      }
    })();
    return inFlight;
  }

  function readCredentialsSafe(): ClaudeSubscriptionCredentialInfo | null {
    try {
      return deps.readCredentials();
    } catch (err) {
      deps.onRefreshError(err);
      return null;
    }
  }

  return {
    async read(): Promise<ClaudeSubscriptionUsageSnapshot | null> {
      const credentials = readCredentialsSafe();
      if (!credentials) {
        // 顺手武装无凭证冷却 —— 本次 IPC 读已确认未登录, turn-done 的 triggerRefresh
        // 在冷却窗口内不必再付一次 keychain 探测。
        noCredentialsUntil = deps.now() + throttleMs;
        // 只在「之前有过凭证」时清一次 —— 未登录用户的常规读不应反复触发 DELETE。
        if (hadCredentials || stateToken !== null) {
          hadCredentials = false;
          await clearCachedSnapshot();
        }
        return null;
      }
      noCredentialsUntil = 0;
      hadCredentials = true;

      const cached = await deps.readCachedSnapshot();
      // 同机换号防护:持久化快照带归属指纹且与当前 token 不符 → 立即清除并返回
      // 无数据(不等后台刷新), 避免 chip 把上一个账号的余量顶给新账号看。指纹缺失
      // (旧快照 / 仅 headers 源)按未知归属沿用, 不误清。
      if (cached?.accountFingerprint
        && cached.accountFingerprint !== deps.fingerprintToken(credentials.accessToken)) {
        await clearCachedSnapshot();
        void triggerRefreshWith(credentials);
        return null;
      }
      void triggerRefreshWith(credentials);
      return cached;
    },

    triggerRefresh(): void {
      // 节流 / 退避预检放在读凭证**之前** —— readCredentials 在 macOS 是同步
      // keychain 子进程读(10-50ms 阻塞主进程), 而本方法被每个 Claude turn-done
      // 无条件调用, 不预检的话节流窗口内的每个 turn 都白付一次。预检用当前
      // stateToken 的节流状态, 不感知 token 变化: 换号场景由 auth-change 钩子与
      // read() 的指纹校验兜底(它们必然伴随一次完整 read), 不依赖这里。
      // in-flight 时同理短路 —— 刷新已在进行, turn-done 的诉求已被满足。
      // 无凭证冷却同为预检的一部分: gateway-only 用户每轮读到 null 若不进冷却,
      // 「无凭证 → 不更新任何节流状态」会让每个 turn-done 都重付一次 keychain 读。
      const now = deps.now();
      if (inFlight) return;
      if (now < backoffUntil) return;
      if (now < noCredentialsUntil) return;
      if (lastRefreshAt > 0 && now - lastRefreshAt < throttleMs) return;

      const credentials = readCredentialsSafe();
      if (!credentials) {
        noCredentialsUntil = now + throttleMs;
        return;
      }
      noCredentialsUntil = 0;
      hadCredentials = true;
      void triggerRefreshWith(credentials);
    },

    async syncForCredentialChange(): Promise<void> {
      const credentials = readCredentialsSafe();
      if (!credentials) {
        // 登出: 无条件清(不看 hadCredentials —— 本进程可能从未观察过凭证,
        // 但磁盘上可能残留上一个进程周期的快照), 广播 null 让 chip 回占位态。
        // 同时武装无凭证冷却, 登出后的 turn-done 不再逐轮探测 keychain。
        hadCredentials = false;
        noCredentialsUntil = deps.now() + throttleMs;
        await clearCachedSnapshot();
        return;
      }
      noCredentialsUntil = 0;
      hadCredentials = true;
      const cached = await deps.readCachedSnapshot();
      if (cached?.accountFingerprint
        && cached.accountFingerprint !== deps.fingerprintToken(credentials.accessToken)) {
        await clearCachedSnapshot();
      }
      void triggerRefreshWith(credentials);
    },
  };
}
