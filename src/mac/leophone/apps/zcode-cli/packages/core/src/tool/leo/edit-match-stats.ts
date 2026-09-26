// ============================================================
// [leo] Edit 匹配策略计数
// ============================================================
// 进程内累计每种匹配策略成功落盘的次数，用来观察宽松匹配器（line_trimmed / indentation_flexible
// / block_anchor）实际触发得有多频繁。每次编辑的策略另外写进 "Tool call completed" 日志的
// editMatchStrategies 字段（见 tool/executor/call-runner.ts 的 [leo] 标记）。不上报、不落盘。

const counts = new Map<string, number>();

export function recordLeoEditMatchStrategies(strategies: readonly string[]): void {
  for (const strategy of strategies) {
    if (!strategy) continue;
    counts.set(strategy, (counts.get(strategy) ?? 0) + 1);
  }
}

export function getLeoEditMatchStats(): Record<string, number> {
  return Object.fromEntries([...counts.entries()].sort(([left], [right]) => (left < right ? -1 : 1)));
}

export function resetLeoEditMatchStats(): void {
  counts.clear();
}

/** 从 Edit 输出里取出本次命中的策略，供 executor 日志使用；不是 Edit 输出时返回 undefined。 */
export function readLeoEditMatchStrategies(output: unknown): string[] | undefined {
  if (typeof output !== "object" || output === null) return undefined;
  const record = output as { leo?: { strategies?: unknown }; matchStrategy?: unknown };
  if (Array.isArray(record.leo?.strategies)) {
    return record.leo.strategies.filter((value): value is string => typeof value === "string");
  }
  return typeof record.matchStrategy === "string" ? [record.matchStrategy] : undefined;
}
