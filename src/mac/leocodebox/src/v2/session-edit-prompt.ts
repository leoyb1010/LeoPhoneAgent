import { lastUserPrompt } from './session-retry';
import type { FlowRow } from './model';

export function canEditLastPrompt(rows?: readonly FlowRow[] | null): boolean {
  return Boolean(lastUserPrompt(rows));
}

export function editLastPromptDraft(draft: string, prompt: string): string {
  return lastUserPrompt([{ k: 'user', key: '1', text: prompt, mode: 'prompt' }]) || draft;
}

export function editLastPromptToast(): string {
  return '上一句已放进输入栏，改完再发';
}
