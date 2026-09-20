/** 模型被输出上限截断时，这一轮不算说完。 */

const INCOMPLETE = new Set(['length', 'max_tokens', 'max_token', 'maxtokens', 'max-tokens']);

export function sessionIncompleteReason(stopReason?: string | null): boolean {
  const raw = String(stopReason ?? '').trim().toLowerCase();
  if (INCOMPLETE.has(raw)) return true;
  return raw.replace(/[\s_-]+/g, '') === 'maxtokens';
}

export function sessionIncompleteLabel(stopReason?: string | null): string {
  return sessionIncompleteReason(stopReason) ? '模型没说完' : '';
}
