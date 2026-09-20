export function sessionCwdKey(cwd?: string | null): string {
  return (cwd ?? '').trim().replace(/\\/g, '/').replace(/\/+$/, '');
}

export function sameSessionCwd(a?: string | null, b?: string | null): boolean {
  const left = sessionCwdKey(a);
  const right = sessionCwdKey(b);
  return Boolean(left && right && left === right);
}

export type SameCwdSession = {
  session_id: string;
  title: string;
  cwd: string;
  updated_at: number;
};

export function sameCwdSessions<T extends {
  machine?: string | null;
  s: { session_id?: string | null; cwd?: string | null; title?: string | null; updated_at?: number | null };
}>(rows: readonly T[], cwd?: string | null, currentId?: string | null): SameCwdSession[] {
  const key = sessionCwdKey(cwd);
  if (!key) return [];
  return rows
    .filter((row) => (row.machine ?? 'local') === 'local'
      && sameSessionCwd(row.s.cwd, key)
      && row.s.session_id
      && row.s.session_id !== currentId)
    .map((row) => ({
      session_id: row.s.session_id as string,
      title: (row.s.title ?? '').replace(/\s+/g, ' ').trim(),
      cwd: sessionCwdKey(row.s.cwd),
      updated_at: row.s.updated_at ?? 0,
    }))
    .sort((a, b) => b.updated_at - a.updated_at);
}

export function canShowSameCwd(machine?: string | null, peers?: readonly unknown[] | null): boolean {
  return machine === 'local' && Boolean(peers?.length);
}

export function sameCwdPickerHint(count: number): string {
  if (count <= 0) return '这个目录没有别的会话';
  return count === 1 ? '1 条同目录会话' : `${count} 条同目录会话`;
}

export function sameCwdToast(title?: string | null): string {
  const name = (title ?? '').replace(/\s+/g, ' ').trim();
  return name ? `已打开「${name}」` : '已打开同目录会话';
}
