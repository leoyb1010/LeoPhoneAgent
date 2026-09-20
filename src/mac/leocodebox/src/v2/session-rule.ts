export const SESSION_RULE_MAX = 400;

export function clipSessionRule(raw: string): string {
  return raw.replace(/\u0000/g, '').replace(/\r\n/g, '\n').replace(/[ \t]+\n/g, '\n').trim().slice(0, SESSION_RULE_MAX);
}

export function canSetSessionRule(machine?: string | null): boolean {
  return machine === 'local';
}

export function applySessionRule(text: string, rule: string): string {
  const body = text.replace(/\u0000/g, '').trim();
  const note = clipSessionRule(rule);
  if (!note || !body) return body;
  if (body.includes(note)) return body;
  return `【会话规矩】\n${note}\n\n${body}`;
}

export function ruleSessionToast(rule: string): string {
  const next = clipSessionRule(rule);
  return next ? '规矩已记下，之后每轮都会带着' : '已去掉这条会话的规矩';
}
