/** First SSE frame for harness events. Mirrors src/harmony/protocol/resumeEnvelope.ts. */

export type ResumeEnvelope = {
  type: 'resume';
  status: 'ok' | 'gap';
  after: number;
  min_after: number;
};

export function resumeEnvelope(after: number, minAfter = 0): ResumeEnvelope {
  const safeAfter = Number.isFinite(after) ? Math.max(0, Math.trunc(after)) : 0;
  const safeMin = Number.isFinite(minAfter) ? Math.max(0, Math.trunc(minAfter)) : 0;
  if (safeAfter < safeMin) {
    return { type: 'resume', status: 'gap', after: safeAfter, min_after: safeMin };
  }
  return { type: 'resume', status: 'ok', after: safeAfter, min_after: safeMin };
}
