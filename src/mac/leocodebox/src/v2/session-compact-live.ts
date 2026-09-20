/** pi 上下文到阈值会自己压；这里只把那一拍翻成一句能看的话。 */

function shortTokens(value: unknown): string {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return '';
  if (n >= 1_000_000) return `${Math.round(n / 100_000) / 10}M`;
  if (n >= 1000) return `${Math.round(n / 1000)}K`;
  return String(Math.round(n));
}

export function sessionCompactingLabel(): string {
  return '正在压缩上下文。';
}

export function sessionCompactedLabel(input: {
  tokensBefore?: unknown;
  tokensAfter?: unknown;
  aborted?: unknown;
} = {}): string {
  if (input.aborted) return '压缩被停掉了。';
  const before = shortTokens(input.tokensBefore);
  const after = shortTokens(input.tokensAfter);
  if (before && after) return `已压缩：${before} → ${after}。`;
  return '已压缩:早先的轮次折成一条摘要,上下文变轻了';
}
