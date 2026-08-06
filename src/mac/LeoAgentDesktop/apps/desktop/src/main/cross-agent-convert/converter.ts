/**
 * cross-agent-convert / converter (dispatcher)
 *
 * 按 kind 分派到对应 converter；逐项串行执行；通过 onStep 回调汇报进度。
 *
 * 单项失败不阻塞其他项 —— 每项独立。最终返回汇总 { successCount, skippedCount, failedCount }。
 */

import { convertAgentsMd } from './converters/agents-md.js';
import { convertMcp } from './converters/mcp.js';
import { convertAgents } from './converters/agents.js';
import { convertHooks } from './converters/hooks.js';
import type { MigrationItem, MigrationStepEvent, MigrationStepStatus } from './types.js';

export interface ConvertSummary {
  total: number;
  successCount: number;
  skippedCount: number;
  failedCount: number;
}

export type StepCallback = (ev: MigrationStepEvent) => void;

export async function convertAll(
  items: MigrationItem[],
  onStep: StepCallback,
): Promise<ConvertSummary> {
  let successCount = 0;
  let skippedCount = 0;
  let failedCount = 0;

  for (const item of items) {
    onStep({ itemId: item.id, status: 'running' });

    let status: MigrationStepStatus;
    let detail: string | undefined;

    try {
      const outcome = await dispatch(item);
      status = outcome.status;
      detail = outcome.detail;
    } catch (err) {
      status = 'failed';
      detail = err instanceof Error ? err.message : String(err);
    }

    if (status === 'success') successCount += 1;
    else if (status === 'skipped') skippedCount += 1;
    else if (status === 'failed') failedCount += 1;

    onStep({ itemId: item.id, status, detail });
  }

  return { total: items.length, successCount, skippedCount, failedCount };
}

async function dispatch(item: MigrationItem): Promise<{ status: MigrationStepStatus; detail?: string }> {
  switch (item.kind) {
    case 'agents-md':
      return convertAgentsMd(item);
    case 'agents':
      return convertAgents(item);
    case 'hooks':
      return convertHooks(item);
    case 'mcp':
      return convertMcp(item);
    default: {
      const _exhaustive: never = item.kind;
      void _exhaustive;
      return { status: 'failed', detail: '未知 kind' };
    }
  }
}
