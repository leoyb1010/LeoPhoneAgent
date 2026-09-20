import { getHarnessManager } from './harness-session.service.js';

export async function listForgottenLocalSessions(): Promise<{ sessions: Array<{ session_id: string; title: string; cwd: string; updated_at: number }> }> {
  const manager = getHarnessManager();
  await manager.ready();
  return { sessions: await manager.listForgotten() };
}

export async function recallForgottenLocalSession(sessionId: string): Promise<{ session_id: string; title: string }> {
  const manager = getHarnessManager();
  const result = await manager.recall(sessionId);
  return result;
}
