/**
 * statusFilter — Automation 列表 status 筛选的领域原语
 * ---------------------------------------------------------------------------
 * 类型与合法值集中在 lib 层,组件(TaskListFilterPopover)与持久化
 * (statusFilterStorage)都从这里 import,避免 lib → component 的反向依赖。
 *
 * 'expired'(一次性任务已触发/已过期)不是 filter 选项 —— 视觉上折进
 * 'active' 桶,cell 自身用 "Once" tag 区分,详见 TaskListFilterPopover 头注。
 */

export type StatusFilter = 'all' | 'active' | 'paused';

export const STATUS_VALUES: readonly StatusFilter[] = ['all', 'active', 'paused'];
