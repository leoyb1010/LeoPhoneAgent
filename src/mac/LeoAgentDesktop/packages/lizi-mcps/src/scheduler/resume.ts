/**
 * scheduler/resume.ts — schedule_resume tool
 */

import { z } from 'zod';

import { withScheduler } from './_shared.js';
import type { SchedulerMcpDeps } from '../types.js';
import type { SchedulerToolRegistry } from '../cindy_schedulerToolRegistry.js';

export function registerScheduleResumeTool(
  registry: SchedulerToolRegistry,
  deps: SchedulerMcpDeps,
): void {
  registry.register({
    name: 'schedule_resume',
    category: 'scheduler',
    description:
      '把 paused schedule 恢复为 active：nextFireAt 按当前时间 + cronExpr 重算（不会"补"暂停期间错过的触发）。',
    inputShape: {
      id: z.string().min(1).describe('要恢复的 schedule id'),
    },
    handler: async ({ id }) =>
      withScheduler(deps, (scheduler) => scheduler.resume(id)),
  });
}
