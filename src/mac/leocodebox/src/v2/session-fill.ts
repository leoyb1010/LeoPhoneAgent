import { clipDraftText } from './session-draft';

/** 技能 set_editor_text 是把下一句写进输入栏，不是再弹一张问句卡。 */

export function composerFillFromSkill(text: unknown): string {
  return clipDraftText(String(text ?? '').replace(/\u0000/g, '').replace(/\r\n/g, '\n'));
}

export function sessionFillLabel(): string {
  return '技能写进了输入栏。';
}

export function canFillComposerDraft(input: { machine?: string | null; fillId?: number }): boolean {
  return input.machine === 'local' && (input.fillId ?? 0) > 0;
}
