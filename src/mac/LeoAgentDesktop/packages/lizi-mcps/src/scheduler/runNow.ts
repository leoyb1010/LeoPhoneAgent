/**
 * scheduler/runNow.ts — schedule_run_now tool
 *
 * 立即触发一次。不改 nextFireAt / lastFiredAt（这些只由 cron-driven fire 推进），
 * 但会 emit 'changed' 让 GUI 历史抽屉刷新。
 */

import { z } from 'zod';

import { withScheduler } from './_shared.js';
import type { SchedulerMcpDeps } from '../types.js';
import type { SchedulerToolRegistry } from '../cindy_schedulerToolRegistry.js';

export function registerScheduleRunNowTool(
  registry: SchedulerToolRegistry,
  deps: SchedulerMcpDeps,
): void {
  registry.register({
    name: 'schedule_run_now',
    category: 'scheduler',
    description:
      '立即触发一次 schedule（手动 fire）。返回新建出来的 runId。注意：不改 nextFireAt / lastFiredAt（cron 节奏不变），但 GUI 列表的"最近触发"会刷新。',
    inputShape: {
      id: z.string().min(1).describe('要立即触发的 schedule id'),
    },
    handler: async ({ id }) =>
      withScheduler(deps, (scheduler) => scheduler.runNow(id)),
  });
}
