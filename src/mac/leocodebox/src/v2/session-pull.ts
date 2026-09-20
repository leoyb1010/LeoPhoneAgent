export function canPullSessionRepo(machine?: string | null): boolean {
  return machine === 'local';
}

export function pullSessionToast(remote: string, branch: string, changed: boolean): string {
  const dest = [remote.trim(), branch.trim()].filter(Boolean).join('/');
  if (!changed) return dest ? `${dest} 已经是最新` : '已经是最新';
  return dest ? `已拉回 ${dest}` : '已拉回远端';
}
