import { sessionIsBusyToHalt } from './session-halt';

export function canStopSession(machine?: string | null, status?: string | null): boolean {
  return machine === 'local' && sessionIsBusyToHalt(status);
}

export function stoppableLocalSessions<T extends { machine?: string | null; s?: { status?: string | null; session_id?: string | null; title?: string | null } }>(
  rows: readonly T[],
): T[] {
  return rows.filter((row) => canStopSession(row.machine ?? 'local', row.s?.status) && row.s?.session_id);
}

export function stopSessionToast(title?: string | null): string {
  const name = (title ?? '').trim();
  return name ? `已停掉 ${name}` : '已停掉这条会话';
}
