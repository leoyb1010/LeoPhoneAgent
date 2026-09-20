import { getHarnessManager } from './harness-session.service.js';

export async function forgetEndedLocalSessions(ids?: readonly string[]): Promise<{ ids: string[]; count: number }> {
  const manager = getHarnessManager();
  const result = await manager.forgetEnded(ids);
  if (!result.ids.length) throw new Error('没有已经结束的会话');
  return { ids: result.ids, count: result.ids.length };
}
