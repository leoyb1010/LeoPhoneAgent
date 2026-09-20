export function pendingApprovalIds(
  pending?: Iterable<{ approvalId?: string | null }> | null,
): string[] {
  if (!pending) return [];
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const row of pending) {
    const id = String(row?.approvalId || '').trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

export function canApproveAllHere(machine?: string | null, ids?: readonly string[] | null): boolean {
  return machine === 'local' && (ids?.length ?? 0) >= 2;
}

export function approveAllLabel(): string {
  return '这次都准';
}

export function approveAllToast(count: number): string {
  if (count <= 0) return '没有待批';
  return `已批准这 ${count} 条`;
}
