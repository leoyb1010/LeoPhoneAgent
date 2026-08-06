import type { RemoteSession } from '@/session/types';

export * from '@cindy/maker-shared/mobile-home';

/**
 * 手机端隐藏 Orca worker 子会话(本期不支持进 worker 子会话聊天),Lead 会话与普通会话保留。
 * **只在 mobile 侧过滤**——桌面仍需显示/管理 worker,绝不动共享的 sessionList 过滤逻辑。
 */
export function excludeOrcaWorkerSessions<T extends Pick<RemoteSession, 'orcaRole'>>(
  sessions: readonly T[],
): T[] {
  return sessions.filter((session) => session.orcaRole !== 'worker');
}
