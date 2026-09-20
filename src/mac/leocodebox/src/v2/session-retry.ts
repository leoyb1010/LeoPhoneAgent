/** pi 过载/限流会自己再试；这里只把那一拍翻成一句能看的话。 */

export function sessionRetryLabel(input: {
  attempt?: unknown;
  max?: unknown;
  delayMs?: unknown;
} = {}): string {
  const attempt = Number(input.attempt);
  const max = Number(input.max);
  const delay = Number(input.delayMs);
  const n = Number.isFinite(attempt) && attempt > 0 ? String(Math.round(attempt)) : '';
  const of = Number.isFinite(max) && max > 0 ? `/${Math.round(max)}` : '';
  const slot = n ? `${n}${of}` : '';
  const wait = Number.isFinite(delay) && delay > 0 ? `${Math.max(1, Math.round(delay / 1000))} 秒后` : '';
  if (wait && slot) return `过载，${wait}再试 ${slot}。`;
  if (wait) return `过载，${wait}再试。`;
  if (slot) return `过载，正在再试 ${slot}。`;
  return '过载，正在再试。';
}
