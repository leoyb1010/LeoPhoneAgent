export function canMergeSessionBranch(machine?: string | null): boolean {
  return machine === 'local';
}

export function mergeSessionToast(from: string, into: string, already: boolean): string {
  const source = from.trim() || '那条分支';
  const dest = into.trim() || '现在这条';
  return already ? `已经并过 ${source}` : `已把 ${source} 并到 ${dest}`;
}
