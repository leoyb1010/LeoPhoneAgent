/**
 * scheduleSessionBinding — "session → 绑定它的 schedules" 反向索引
 * ---------------------------------------------------------------------------
 * heartbeat 模式的 schedule 通过 targetSessionId 绑定到已有 session。本模块从
 * schedulesStore 的列表快照构建 sessionId → Schedule[] 的反向 Map,供侧边栏
 * SessionItem / 会话头部显示"被自动化任务绑定"徽章。
 *
 * 性能约定(会话列表可能上百项,每项都调 hook):
 *   - Map 按输入引用做模块级 memo:schedulesStore 的 cache 引用只在 fetch 成功
 *     swap 时变化,所有 hook 实例共享一次 O(schedules) 构建,每项查询 O(1)。
 *   - 未命中返回冻结的 EMPTY 常量,保证引用稳定,不触发下游无谓重渲染。
 *   - hook 自带 ensure():schedulesStore 目前只在 SchedulerPage 挂载时加载,
 *     sidebar 场景必须自己触发;命中 cache 是 no-op,inflight 去重保证上百个
 *     实例并发也只打一次 IPC。
 *
 * 徽章消失链路:schedule create/delete/pause/resume/expired 都会让 main 广播
 * 'changed' → schedulesStore.forceRefresh → cache 引用更新 → Map 重建。
 */

import { useEffect } from 'react';
import type { Schedule } from '@cindy/maker-scheduler';

import { schedulesStore, useSchedulesSnapshot } from './schedulesStore';

const EMPTY: readonly Schedule[] = Object.freeze([]);

/**
 * 跳到自动化页并 focus 指定任务的路由(与侧边栏自动化分组"编辑"同款 query
 * 机制,SchedulerPage 读 ?focus= 选中条目;任务已删除时页面兜底回退首条)。
 */
export function scheduleFocusPath(scheduleId: string): string {
  return `/cc-agent/scheduled?focus=${encodeURIComponent(scheduleId)}`;
}

let lastInput: Schedule[] | null = null;
let lastMap: ReadonlyMap<string, Schedule[]> = new Map();

/**
 * 从 schedule 列表构建 targetSessionId → Schedule[] 反向 Map。
 * 过滤 expired(已过期的绑定不该再显示徽章);paused 保留(显示弱化态)。
 * 同一输入引用直接返回上次结果(引用稳定)。
 */
export function buildBindingMap(
  schedules: Schedule[] | null,
): ReadonlyMap<string, Schedule[]> {
  if (schedules === lastInput) return lastMap;
  const map = new Map<string, Schedule[]>();
  for (const schedule of schedules ?? []) {
    if (!schedule.targetSessionId || schedule.status === 'expired') continue;
    const list = map.get(schedule.targetSessionId);
    if (list) {
      list.push(schedule);
    } else {
      map.set(schedule.targetSessionId, [schedule]);
    }
  }
  lastInput = schedules;
  lastMap = map;
  return map;
}

/** Testing 入口:清掉模块级 memo,仅 vitest 用。 */
export function __resetBindingMemoForTest(): void {
  lastInput = null;
  lastMap = new Map();
}

/**
 * 返回绑定到指定 session 的 schedules(active / paused;expired 已滤)。
 * 无绑定时返回引用稳定的空数组。
 */
export function useSessionBoundSchedules(sessionId: string): readonly Schedule[] {
  const snapshot = useSchedulesSnapshot();
  useEffect(() => {
    // 命中 cache 是 no-op;失败静默 — schedulesStore 内部已记 lastError,
    // 徽章属增强信息,不值得在 sidebar 弹错误。
    void schedulesStore.ensure().catch(() => {});
  }, []);
  return buildBindingMap(snapshot).get(sessionId) ?? EMPTY;
}
