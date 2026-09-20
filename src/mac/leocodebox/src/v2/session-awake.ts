import { sessionIsBusyToHalt } from './session-halt';

export function shouldKeepAwake(rows: ReadonlyArray<{ machine?: string | null; s?: { status?: string | null } }>): boolean {
  return rows.some((row) => (row.machine ?? 'local') === 'local' && sessionIsBusyToHalt(row.s?.status));
}
