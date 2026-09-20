export const SESSION_LOG_MAX = 20;

export type SessionCommit = { hash: string; subject: string; at: number };

export function canShowSessionLog(machine?: string | null): boolean {
  return machine === 'local';
}

export function isCommitHash(raw: string): boolean {
  return /^[0-9a-f]{7,40}$/i.test(raw.trim());
}

export function clipCommitSubject(raw: string, limit = 80): string {
  return raw.replace(/\s+/g, ' ').trim().slice(0, limit);
}

export function sessionLogToast(count: number): string {
  if (count <= 0) return '这个目录还没有提交';
  return `最近 ${count} 次提交`;
}
