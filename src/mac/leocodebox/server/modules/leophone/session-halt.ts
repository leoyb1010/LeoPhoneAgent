import { getHarnessManager } from './harness-session.service.js';

export const HALT_BUSY_STATUSES = new Set(['starting', 'running', 'waiting_for_approval']);

export function sessionIsBusyToHalt(status?: string | null): boolean {
  return Boolean(status && HALT_BUSY_STATUSES.has(status));
}

export async function haltBusyLocalSessions(): Promise<{ ids: string[]; count: number }> {
  const manager = getHarnessManager();
  await manager.ready();
  const result = await manager.haltBusy();
  if (!result.ids.length) throw new Error('没有正在跑的会话');
  return { ids: result.ids, count: result.ids.length };
}
