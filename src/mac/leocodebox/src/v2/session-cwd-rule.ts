export const CWD_RULE_MAX = 400;

export function clipCwdRule(raw: string): string {
  return raw.replace(/\u0000/g, '').replace(/\r\n/g, '\n').replace(/[ \t]+\n/g, '\n').trim().slice(0, CWD_RULE_MAX);
}

export function canSetCwdRule(machine?: string | null): boolean {
  return machine === 'local';
}

export function applyCwdRule(text: string, rule: string): string {
  const body = text.replace(/\u0000/g, '').trim();
  const note = clipCwdRule(rule);
  if (!note || !body) return body;
  if (body.includes(note)) return body;
  return `【目录规矩】\n${note}\n\n${body}`;
}

export function cwdRuleToast(rule: string): string {
  const next = clipCwdRule(rule);
  return next ? '目录规矩已记下，同一目录新开也会带着' : '已去掉这个目录的规矩';
}
