export function deniableApprovalIds(
  pending?: Iterable<{ approvalId?: string | null; choices?: readonly string[] | null }> | null,
): string[] {
  if (!pending) return [];
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const row of pending) {
    const id = String(row?.approvalId || '').trim();
    if (!id || seen.has(id)) continue;
    const choices = row.choices ?? ['once', 'deny'];
    if (!choices.includes('deny')) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

export function canDenyAllHere(machine?: string | null, ids?: readonly string[] | null): boolean {
  return machine === 'local' && (ids?.length ?? 0) >= 2;
}

export function denyAllLabel(): string {
  return '这次都拒';
}

export function denyAllToast(count: number): string {
  if (count <= 0) return '没有待批';
  return `已拒绝这 ${count} 条`;
}
