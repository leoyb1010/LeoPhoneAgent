export function canInitSessionRepo(machine?: string | null): boolean {
  return machine === 'local';
}

export function initSessionToast(created: boolean, branch?: string): string {
  if (!created) return '已经是仓库';
  const name = (branch ?? '').trim();
  return name ? `已做成仓库 · ${name}` : '已做成仓库';
}
