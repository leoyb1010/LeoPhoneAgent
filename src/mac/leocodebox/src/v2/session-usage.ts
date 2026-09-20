/** 上一句助手写完时，把这一轮用量写成流水，不做统计页。 */

function shortTokens(value: unknown): string {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return '';
  if (n >= 1_000_000) return `${Math.round(n / 100_000) / 10}M`;
  if (n >= 1000) return `${Math.round(n / 1000)}K`;
  return String(Math.round(n));
}

export function sessionUsageLabel(input: { totalTokens?: unknown; input?: unknown; output?: unknown } = {}): string {
  const total = shortTokens(input.totalTokens);
  if (total) return `这一轮 ${total}。`;
  const inputN = shortTokens(input.input);
  const outputN = shortTokens(input.output);
  if (inputN && outputN) return `这一轮 ${inputN} → ${outputN}。`;
  return '';
}
