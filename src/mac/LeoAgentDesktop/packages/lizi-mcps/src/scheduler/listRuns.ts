/**
 * scheduler/listRuns.ts — schedule_list_runs tool
 */

import { z } from 'zod';

import { withScheduler } from './_shared.js';
import type { SchedulerMcpDeps } from '../types.js';
import type { SchedulerToolRegistry } from '../cindy_schedulerToolRegistry.js';

export function registerScheduleListRunsTool(
  registry: SchedulerToolRegistry,
  deps: SchedulerMcpDeps,
): void {
  registry.register({
    name: 'schedule_list_runs',
    category: 'scheduler',
    description:
      '列出某条 schedule 的历史触发记录（ScheduleRun[]，按 firedAt DESC 倒序）。可调 limit；storage 默认 50。',
    inputShape: {
      scheduleId: z.string().min(1).describe('Schedule id'),
      limit: z
        .number()
        .int()
        .min(1)
        .max(500)
        .optional()
        .describe('返回最近 N 条；省略 = storage 默认 50'),
    },
    handler: async ({ scheduleId, limit }) =>
      withScheduler(deps, (scheduler) => scheduler.listRuns(scheduleId, limit)),
  });
}
