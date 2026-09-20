export const HALT_BUSY_STATUSES = new Set(['starting', 'running', 'waiting_for_approval']);

export function sessionIsBusyToHalt(status?: string | null): boolean {
  return Boolean(status && HALT_BUSY_STATUSES.has(status));
}

export function busyLocalSessionIds(rows: ReadonlyArray<{ machine?: string | null; s?: { status?: string | null; session_id?: string | null } }>): string[] {
  return rows
    .filter((row) => (row.machine ?? 'local') === 'local' && sessionIsBusyToHalt(row.s?.status) && row.s?.session_id)
    .map((row) => row.s!.session_id as string);
}

export function canHaltBusySessions(rows: ReadonlyArray<{ machine?: string | null; s?: { status?: string | null } }>): boolean {
  return rows.some((row) => (row.machine ?? 'local') === 'local' && sessionIsBusyToHalt(row.s?.status));
}

export function haltSessionsToast(count: number): string {
  return count <= 1 ? '已停掉正在跑的会话' : `已停掉 ${count} 条正在跑的会话`;
}
