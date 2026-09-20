/** 技能 notify / 扩展抛错时，话写进流水，不弹系统通知。 */

export function skillNoteLabel(input: { text?: unknown; level?: unknown } = {}): string {
  const text = String(input.text ?? '').replace(/\s+/g, ' ').trim().slice(0, 240);
  if (input.level === 'error' && text) return `技能出错:${text}`;
  return text || '技能说了一声。';
}

export function skillNoteTone(level?: unknown): 'muted' | 'error' {
  return level === 'error' || level === 'warning' ? 'error' : 'muted';
}
