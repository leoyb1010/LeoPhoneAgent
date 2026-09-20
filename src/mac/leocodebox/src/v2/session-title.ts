export const SESSION_TITLE_MAX = 80;

export function clipSessionTitle(raw: string): string {
  return raw.replace(/[\r\n\u0000]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, SESSION_TITLE_MAX);
}

export function canRenameSession(machine?: string | null): boolean {
  return machine === 'local';
}

export function renameSessionToast(title: string): string {
  const next = clipSessionTitle(title);
  return next ? `标题改成「${next}」` : '标题已改';
}
