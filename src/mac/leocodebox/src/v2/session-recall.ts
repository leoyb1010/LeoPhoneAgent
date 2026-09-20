export function canRecallForgotten(machine?: string | null): boolean {
  return machine === 'local';
}

export function recallSessionToast(title: string): string {
  const next = title.replace(/\s+/g, ' ').trim();
  return next ? `已找回「${next}」` : '已找回这条会话';
}

export type ForgottenSession = {
  session_id: string;
  title: string;
  cwd: string;
  updated_at: number;
};
