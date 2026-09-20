export const DENY_REASON_MAX = 200;

export function clipDenyReason(text: string, limit = DENY_REASON_MAX): string {
  return text.replace(/\u0000/g, '').replace(/\s+/g, ' ').trim().slice(0, limit);
}

export function canDenyWithReason(choices?: readonly string[] | null): boolean {
  return Boolean(choices?.includes('deny'));
}

export function denySessionToast(reason: string): string {
  return clipDenyReason(reason) ? '已拒绝，并告诉了模型为什么' : '已拒绝';
}
