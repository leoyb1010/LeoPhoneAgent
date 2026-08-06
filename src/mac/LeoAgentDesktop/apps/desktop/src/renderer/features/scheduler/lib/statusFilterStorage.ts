/**
 * statusFilterStorage — Automation 列表 status 筛选的持久化(GitHub issue #75)
 * ---------------------------------------------------------------------------
 * 记住用户上次在 TaskListFilterPopover 主动选择的筛选值,SchedulerPage 重新挂载
 * (切去会话再切回自动化管理)时恢复,而非每次重置为初始默认值(尊重用户上次的选择)。
 *
 * 只持久化用户主动切换:?focus=<id> 跳转的自动同步、新建任务后切回 active 这类
 * 程序性 setStatusFilter 不写入,避免覆盖用户偏好(用户选了 All,点一个 paused
 * 任务的跳转通知后,下次进来仍应是 All)。
 */

import { STATUS_VALUES, type StatusFilter } from './statusFilter';

// 与同模块 TaskListPane 的 'xdt:scheduler.collapsedProjects' 同前缀
const STORAGE_KEY = 'xdt:scheduler.statusFilter';

const DEFAULT_STATUS_FILTER: StatusFilter = 'all';

/** 读取上次持久化的筛选值;无记录 / 值非法 / storage 不可用时回默认 'all'(展示全部任务)。 */
export function loadStatusFilter(): StatusFilter {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return STATUS_VALUES.includes(raw as StatusFilter)
      ? (raw as StatusFilter)
      : DEFAULT_STATUS_FILTER;
  } catch {
    return DEFAULT_STATUS_FILTER;
  }
}

/** 持久化用户主动选择的筛选值;storage 不可用(quota / disabled)时静默忽略。 */
export function persistStatusFilter(value: StatusFilter): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, value);
  } catch {
    /* ignore quota / disabled storage */
  }
}
