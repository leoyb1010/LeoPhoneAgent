/**
 * scheduler/list.ts — schedule_list tool
 *
 * 透传 Scheduler.list(filter?) 返回值，与 maker.schedule.list() IPC 同形（plan
 * §C.6 硬规则：禁止 snake/camel 二次转换或裁字段，MCP / GUI 必须看到同一份数据）。
 */

import { z } from 'zod';

import { SCHEDULE_STATUS } from './_enums.js';
import { withScheduler } from './_shared.js';
import type { SchedulerMcpDeps } from '../types.js';
import type { SchedulerToolRegistry } from '../cindy_schedulerToolRegistry.js';

export function registerScheduleListTool(
  registry: SchedulerToolRegistry,
  deps: SchedulerMcpDeps,
): void {
  registry.register({
    name: 'schedule_list',
    category: 'scheduler',
    description:
      '列出所有 schedule（与 GUI 列表同源同形）。可选按 status 过滤：active / paused / expired。返回 Schedule[] 完整字段（含 cron 表达式 / nextFireAt / lastFiredAt / notify 嵌套对象等）。',
    inputShape: {
      status: z
        .enum(SCHEDULE_STATUS)
        .optional()
        .describe('过滤指定状态；不传 = 返回全部'),
    },
    handler: async ({ status }) =>
      withScheduler(deps, (scheduler) =>
        scheduler.list(status ? { status } : undefined),
      ),
  });
}
