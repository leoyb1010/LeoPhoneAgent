export const BRANCH_NAME_MAX = 80;

export function canSwitchSessionBranch(machine?: string | null): boolean {
  return machine === 'local';
}

export function sanitizeBranchName(raw: string): string {
  const parts = raw.replace(/\u0000/g, '').replace(/\\/g, '/').trim().split('/').map((part) => {
    const clean = part.replace(/[^\w.\u4e00-\u9fff-]+/g, '-').replace(/^-+|-+$/g, '');
    if (!clean || clean === '.' || clean === '..' || clean.toUpperCase() === 'HEAD') return '';
    return clean;
  }).filter(Boolean);
  return parts.join('/').slice(0, BRANCH_NAME_MAX) || 'leo-分支';
}

export function switchSessionBranchToast(branch: string, created: boolean): string {
  const name = branch.trim() || 'leo-分支';
  return created ? `已开到 ${name}` : `已切到 ${name}`;
}
