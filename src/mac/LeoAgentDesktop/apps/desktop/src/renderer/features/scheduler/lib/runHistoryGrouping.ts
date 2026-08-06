import type { ScheduleRun } from '@cindy/maker-scheduler';

export type RunHistoryDisplayEntry =
  | { kind: 'run'; key: string; run: ScheduleRun }
  | { kind: 'session'; key: string; sessionId: string; runs: ScheduleRun[] };

/**
 * 持续会话按 sessionId 二次分组，但不丢弃任何 run；无 sessionId 的失败/跳过记录
 * 保持原位置独立展示。非持续会话维持原来的逐 run 平铺。
 */
export function groupRunsForHistory(
  runs: readonly ScheduleRun[],
  groupBySession: boolean,
): RunHistoryDisplayEntry[] {
  if (!groupBySession) {
    return runs.map((run) => ({ kind: 'run', key: run.id, run }));
  }

  const entries: RunHistoryDisplayEntry[] = [];
  const groups = new Map<string, Extract<RunHistoryDisplayEntry, { kind: 'session' }>>();
  for (const run of runs) {
    if (!run.sessionId) {
      entries.push({ kind: 'run', key: run.id, run });
      continue;
    }
    const existing = groups.get(run.sessionId);
    if (existing) {
      existing.runs.push(run);
      continue;
    }
    const group: Extract<RunHistoryDisplayEntry, { kind: 'session' }> = {
      kind: 'session',
      key: `session:${run.sessionId}`,
      sessionId: run.sessionId,
      runs: [run],
    };
    groups.set(run.sessionId, group);
    entries.push(group);
  }
  return entries;
}
