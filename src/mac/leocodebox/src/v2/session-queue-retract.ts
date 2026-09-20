export type QueuedFollowUp = { key: string; text: string };

export function retractLastFollowUp(queued?: readonly QueuedFollowUp[] | null): {
  text: string;
  rest: QueuedFollowUp[];
} | null {
  if (!queued?.length) return null;
  const last = queued[queued.length - 1];
  const text = String(last?.text ?? '').trim();
  if (!text) return null;
  return { text, rest: queued.slice(0, -1).map((row) => ({ key: row.key, text: row.text })) };
}

export function canRetractFollowUp(input: {
  machine?: string | null;
  draft?: string | null;
  queued?: readonly QueuedFollowUp[] | null;
}): boolean {
  if (input.machine !== 'local') return false;
  if (String(input.draft ?? '').trim()) return false;
  return retractLastFollowUp(input.queued) != null;
}
