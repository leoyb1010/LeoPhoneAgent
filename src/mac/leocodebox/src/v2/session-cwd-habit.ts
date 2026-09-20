import { LAST_MODEL_KEY } from './model';
import { sessionCwdKey } from './session-here';

export const CWD_HABITS_KEY = 'leo2.cwdHabits';
export const CWD_HABIT_MAX = 40;

const POLICIES = new Set(['default', 'accept_edits', 'plan', 'auto']);

export type CwdHabit = { model: string; policy: string };

export function clipCwdModel(model?: string | null): string {
  const next = (model ?? '').trim();
  if (!next || next.length > 160 || !next.includes('/')) return '';
  return next;
}

export function clipCwdPolicy(policy?: string | null): string {
  const next = (policy ?? '').trim();
  return POLICIES.has(next) ? next : '';
}

export function readCwdHabits(raw?: string | null): Record<string, CwdHabit> {
  if (!raw?.trim()) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: Record<string, CwdHabit> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      const cwd = sessionCwdKey(key);
      if (!cwd) continue;
      const row = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
      const model = clipCwdModel(typeof row.model === 'string' ? row.model : '');
      const policy = clipCwdPolicy(typeof row.policy === 'string' ? row.policy : '');
      if (!model && !policy) continue;
      out[cwd] = { model, policy };
    }
    return out;
  } catch {
    return {};
  }
}

export function lastCwdHabit(cwd?: string | null, raw?: string | Record<string, CwdHabit> | null): CwdHabit | null {
  const key = sessionCwdKey(cwd);
  if (!key) return null;
  const store = typeof raw === 'string' || raw == null ? readCwdHabits(raw) : raw;
  return store[key] ?? null;
}

export function rememberCwdHabit(
  store: Record<string, CwdHabit>,
  cwd?: string | null,
  input?: { model?: string | null; policy?: string | null },
): Record<string, CwdHabit> {
  const key = sessionCwdKey(cwd);
  const model = clipCwdModel(input?.model);
  const policy = clipCwdPolicy(input?.policy);
  if (!key || (!model && !policy)) return store;
  const prev = store[key];
  const next: Record<string, CwdHabit> = { ...store };
  delete next[key];
  next[key] = {
    model: model || prev?.model || '',
    policy: policy || prev?.policy || '',
  };
  const keys = Object.keys(next);
  if (keys.length > CWD_HABIT_MAX) delete next[keys[0]];
  return next;
}

export function pickCwdModel(input: {
  cwd?: string | null;
  habits?: string | Record<string, CwdHabit> | null;
  explicit?: string | null;
  fallback?: string | null;
}): string {
  return clipCwdModel(input.explicit) || lastCwdHabit(input.cwd, input.habits)?.model || clipCwdModel(input.fallback) || '';
}

export function pickCwdPolicy(input: {
  cwd?: string | null;
  habits?: string | Record<string, CwdHabit> | null;
  explicit?: string | null;
  fallback?: string | null;
}): string {
  return clipCwdPolicy(input.explicit) || lastCwdHabit(input.cwd, input.habits)?.policy || clipCwdPolicy(input.fallback) || '';
}

export function loadCwdHabits(): Record<string, CwdHabit> {
  try {
    return readCwdHabits(localStorage.getItem(CWD_HABITS_KEY));
  } catch {
    return {};
  }
}

export function saveCwdHabit(cwd?: string | null, input?: { model?: string | null; policy?: string | null }): void {
  try {
    const next = rememberCwdHabit(loadCwdHabits(), cwd, input);
    localStorage.setItem(CWD_HABITS_KEY, JSON.stringify(next));
    const model = clipCwdModel(input?.model);
    if (model) localStorage.setItem(LAST_MODEL_KEY, model);
  } catch {
    // 隐私模式写不进去也不挡开会话。
  }
}
