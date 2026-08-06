/**
 * scheduler/get.ts — schedule_get tool
 */

import { z } from 'zod';

import { withScheduler } from './_shared.js';
import type { SchedulerMcpDeps } from '../types.js';
import type { SchedulerToolRegistry } from '../cindy_schedulerToolRegistry.js';

export function registerScheduleGetTool(
  registry: SchedulerToolRegistry,
  deps: SchedulerMcpDeps,
): void {
  registry.register({
    name: 'schedule_get',
    category: 'scheduler',
    description:
      '按 id 取单条 schedule 的完整字段（与 GUI 详情同源）。schedule 不存在时 data=null（不算错误）。',
    inputShape: {
      id: z.string().min(1).describe('Schedule id（来自 schedule_list / schedule_create 返回）'),
    },
    handler: async ({ id }) =>
      withScheduler(deps, (scheduler) => scheduler.get(id)),
  });
}
