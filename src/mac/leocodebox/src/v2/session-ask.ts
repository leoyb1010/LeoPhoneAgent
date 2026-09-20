/** 技能用 input/editor 问一句时，pi 会卡住等答。 */

export function isAskMethod(method: unknown): boolean {
  return method === 'input' || method === 'editor';
}

export function askChoices(): string[] {
  return ['reply', 'deny'];
}

export function askRespondedLabel(choice: string, text = ''): string | null {
  if (choice !== 'reply') return null;
  const line = text.replace(/\s+/g, ' ').trim().split('\n')[0] ?? '';
  return line ? `已回答:${line}` : '已回答';
}
