import type { AttentionKind } from '@/lib/sessionAttentionStore';

export type SidebarRightStatusKind = 'error' | 'awaiting' | 'running' | 'done' | 'time';

export interface SidebarRightStatusInput {
  /**
   * store 记录的 attention kind(按 sessionId 精准订阅取得);
   * 定时任务未读(attentionKind 缺失)语义等同 'done'。
   */
  attentionKind: AttentionKind | undefined;
  /** 定时任务未读且非成功结局(failed/aborted/interrupted)—— 语义等同 error。 */
  isUrgentFromContext: boolean;
  isRunning: boolean;
  hasAttentionNotification: boolean;
}

/**
 * 右侧状态槽优先级:error > awaiting > running > done(完成未读)> time。
 * error / awaiting 拆成两档两色(红 / TapTap 蓝),与灵动岛 phase 色表一致;
 * 两者都压过 running spinner —— "需要你处理"永远最高。
 */
export function resolveSidebarRightStatus({
  attentionKind,
  isUrgentFromContext,
  isRunning,
  hasAttentionNotification,
}: SidebarRightStatusInput): SidebarRightStatusKind {
  if (isUrgentFromContext || (hasAttentionNotification && attentionKind === 'error')) return 'error';
  if (hasAttentionNotification && attentionKind === 'awaiting') return 'awaiting';
  if (isRunning) return 'running';
  if (hasAttentionNotification) return 'done';
  return 'time';
}
