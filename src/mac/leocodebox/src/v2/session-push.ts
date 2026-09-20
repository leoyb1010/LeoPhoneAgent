export function canPushSessionRepo(machine?: string | null): boolean {
  return machine === 'local';
}

export function pushSessionToast(remote: string, branch: string): string {
  const dest = [remote.trim(), branch.trim()].filter(Boolean).join('/');
  return dest ? `已推到 ${dest}` : '已推到远端';
}
