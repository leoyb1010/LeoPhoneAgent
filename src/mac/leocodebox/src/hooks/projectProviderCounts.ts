export function incrementProjectProviderCount(
  counts: Record<string, number> | undefined,
  provider: string,
): Record<string, number> {
  return {
    ...counts,
    [provider]: Number(counts?.[provider] ?? 0) + 1,
  };
}
