/**
 * sessionRightStatus —— 会话行右侧状态槽的档位判定(纯函数,便于单测)。
 *
 * 与桌面版侧栏 `sidebarRightStatus.ts` 同一套五档优先级与全端统一色表:
 *   1. error(出错未读)          → 红点(--card-status-error / colors.statusError)
 *   2. awaiting(等待回复/选择)  → TapTap 蓝点(colors.statusAwaiting)
 *   3. running                    → spinner 动画(中性色,橙色语义由行首 vendor icon 呼吸表达)
 *   4. done(完成未读)           → 绿点(colors.statusDone)
 *   5. time                       → 最近活动时间文字
 *
 * 手机端信号来源(与桌面的 attention store 对应关系):
 *   - liveActivity(桌面 main 的会话活动 relay,#368):phase 四态 + attention 未读标志。
 *     attention 的已读语义由 main 侧维护(error 未读要等真实展示才清,与桌面一致),
 *     手机端只消费,不自己猜。
 *   - pendingInteractionCount:实时待处理交互数(ask-user / 权限 / 计划审阅)——
 *     即使 liveActivity 缺失(relay 断连)也能点亮 awaiting。
 *   - scheduleUnreadCount:定时任务未读运行数(schedule 索引)。注意手机端的
 *     schedule 索引暂不带"失败结局"信息,失败未读会落绿档(桌面是红);
 *     等共享层补充 hasUnreadFailedRun 后在这里升红。
 */

export type MobileSessionRightStatus = 'error' | 'awaiting' | 'running' | 'done' | 'time';

export interface MobileSessionRightStatusInput {
  /** liveActivity.phase(缺失 = 无 relay 数据)。 */
  livePhase: 'running' | 'needs-interaction' | 'completed' | 'error' | undefined;
  /** liveActivity.attention === true(未读标志,main 侧维护已读语义)。 */
  liveAttention: boolean;
  /** 实时待处理交互数(ask-user / 权限 / 计划审阅)。 */
  pendingInteractionCount: number;
  /** 会话(或其绑定 schedule)是否正在运行。 */
  running: boolean;
  /** 定时任务未读运行数。 */
  scheduleUnreadCount: number;
}

export function resolveMobileSessionRightStatus({
  livePhase,
  liveAttention,
  pendingInteractionCount,
  running,
  scheduleUnreadCount,
}: MobileSessionRightStatusInput): MobileSessionRightStatus {
  if (liveAttention && livePhase === 'error') return 'error';
  if (pendingInteractionCount > 0 || (liveAttention && livePhase === 'needs-interaction')) {
    return 'awaiting';
  }
  if (running) return 'running';
  if (scheduleUnreadCount > 0 || (liveAttention && livePhase === 'completed')) return 'done';
  return 'time';
}
