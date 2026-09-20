export const DONE_CHIME_KEY = 'leo2.doneChime';

const WORKING = new Set(['starting', 'running']);
const QUIET = new Set(['idle', 'completed', 'failed', 'cancelled', 'orphaned', 'waiting_for_approval']);

export function shouldPlayDoneChime(prev?: string | null, next?: string | null): boolean {
  return WORKING.has(String(prev ?? '')) && QUIET.has(String(next ?? '')) && prev !== next;
}

export function canPlayDoneChime(desktop?: { playDoneSound?: unknown } | null): boolean {
  return Boolean(desktop?.playDoneSound);
}

export function readDoneChimeOn(raw?: string | null): boolean {
  return raw !== 'false';
}

export function doneChimeToast(on: boolean): string {
  return on ? '已设成跑完响一声' : '已关掉跑完提示音';
}

export function doneChimeLabel(on: boolean): string {
  return on ? '跑完不要响' : '跑完响一声';
}

export function chimesFromSnapshot(input: {
  primed: boolean;
  prev: ReadonlyMap<string, string>;
  next: ReadonlyArray<{ key: string; machine?: string | null; status?: string | null }>;
}): { count: number; map: Map<string, string> } {
  const map = new Map(input.next.map((row) => [row.key, String(row.status ?? '')]));
  if (!input.primed) return { count: 0, map };
  let count = 0;
  for (const row of input.next) {
    if ((row.machine ?? 'local') !== 'local') continue;
    if (shouldPlayDoneChime(input.prev.get(row.key), row.status)) count += 1;
  }
  return { count, map };
}
