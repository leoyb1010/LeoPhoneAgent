import { sessionCanForget, sessionKey } from './model';

export function endedLocalSessionIds(
  rows: ReadonlyArray<{ machine?: string | null; s?: { status?: string | null; session_id?: string | null } }>,
  pinned: readonly string[] = [],
): string[] {
  const pins = new Set(pinned);
  return rows
    .filter((row) => (
      (row.machine ?? 'local') === 'local'
      && sessionCanForget(row.s?.status ?? '')
      && row.s?.session_id
      && !pins.has(sessionKey('local', row.s.session_id))
    ))
    .map((row) => row.s!.session_id as string);
}

export function canForgetEndedSessions(
  rows: ReadonlyArray<{ machine?: string | null; s?: { status?: string | null; session_id?: string | null } }>,
  pinned: readonly string[] = [],
): boolean {
  return endedLocalSessionIds(rows, pinned).length > 0;
}

export function forgetEndedToast(count: number): string {
  return count <= 1 ? '已清掉已经结束的会话' : `已清掉 ${count} 条已经结束的会话`;
}
