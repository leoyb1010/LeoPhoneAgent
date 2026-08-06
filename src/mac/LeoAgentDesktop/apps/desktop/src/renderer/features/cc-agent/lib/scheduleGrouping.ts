/**
 * scheduleGrouping — 把 schedules 按 workingDir 分组（cc-agent sidebar 用）
 * ---------------------------------------------------------------------------
 * 与 projectGrouping.ts 范式一致：
 *   - normalize workingDir（POSIX 斜杠 / 去 trailing slash / 保留盘符根）
 *   - 同名消歧：basename 冲突时附 parent 段（最多 3 段）
 *   - workingDir 缺失（heartbeat 模式 schedule 无 workingDir）→ '__nodir__' 单独一组
 *   - 组内 schedule 按 status (active < paused < expired) 然后 nextFireAt asc 排序
 *   - 组间按"组内任意 schedule 的最近 nextFireAt"升序（active 优先到顶）
 */

import type { Schedule } from '@cindy/maker-scheduler/types';
import {
  extractDisplayName,
  normalizeWorkingDir,
} from './projectGrouping';

type TFunc = (key: string) => string;

export interface ScheduleGroupNode {
  /** 归一化后的 workingDir；null = heartbeat / 缺 workingDir */
  workingDir: string | null;
  /** 显示名：basename + 必要的 parent 段消歧；null workingDir 时由 t 决定文案 */
  displayName: string;
  schedules: Schedule[];
  /** 组内最早的 nextFireAt（active first），用于组间排序 */
  earliestNextFireAt: number;
}

const STATUS_RANK: Record<Schedule['status'], number> = {
  active: 0,
  paused: 1,
  expired: 2,
};

function compareSchedules(a: Schedule, b: Schedule): number {
  const r = STATUS_RANK[a.status] - STATUS_RANK[b.status];
  if (r !== 0) return r;
  const an = a.nextFireAt ?? Number.POSITIVE_INFINITY;
  const bn = b.nextFireAt ?? Number.POSITIVE_INFINITY;
  if (an !== bn) return an - bn;
  return b.updatedAt - a.updatedAt;
}

export function groupSchedules(schedules: readonly Schedule[], t?: TFunc): ScheduleGroupNode[] {
  if (!schedules || schedules.length === 0) return [];

  const groups = new Map<string | null, Schedule[]>();
  for (const s of schedules) {
    const dir = normalizeWorkingDir(s.workingDir ?? null);
    const key = dir;
    const arr = groups.get(key);
    if (arr) arr.push(s);
    else groups.set(key, [s]);
  }

  const allDirs = Array.from(groups.keys()).filter((k): k is string => k != null);
  const out: ScheduleGroupNode[] = [];
  for (const [dir, sess] of groups) {
    const sorted = sess.slice().sort(compareSchedules);
    let earliest = Number.POSITIVE_INFINITY;
    for (const s of sess) {
      if (s.status === 'active' && s.nextFireAt && s.nextFireAt < earliest) {
        earliest = s.nextFireAt;
      }
    }
    let displayName: string;
    if (dir == null) {
      displayName = t ? t('ccAgent.schedule.unspecifiedDir') : 'Unspecified directory';
    } else {
      const r = extractDisplayName(dir, allDirs, 1);
      displayName = r.name;
    }
    out.push({
      workingDir: dir,
      displayName,
      schedules: sorted,
      earliestNextFireAt: earliest,
    });
  }

  // 组间排序：earliestNextFireAt 升序（active 优先到顶；全 paused/expired 的组到末尾）
  out.sort((a, b) => a.earliestNextFireAt - b.earliestNextFireAt);
  return out;
}
