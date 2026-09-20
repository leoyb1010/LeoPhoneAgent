export const DICTATE_TEXT_MAX = 2000;

export type SpeechRecognitionLike = {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((event: { results?: ArrayLike<{ 0?: { transcript?: string } }> }) => void) | null;
  onerror: ((event: { error?: string }) => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
};

export function clipDictateText(raw?: string | null, limit = DICTATE_TEXT_MAX): string {
  const next = (raw ?? '').replace(/\u0000/g, '').replace(/\s+/g, ' ').trim();
  if (!next) return '';
  return next.length <= limit ? next : next.slice(0, limit);
}

export function appendDictate(draft: string, heard: string): string {
  const next = clipDictateText(heard);
  if (!next) return draft;
  const cur = (draft ?? '').replace(/\s+$/g, '');
  return cur ? `${cur} ${next}` : next;
}

export function canDictate(machine?: string | null): boolean {
  return machine === 'local';
}

export function speechRecognitionCtor(): (new () => SpeechRecognitionLike) | null {
  if (typeof window === 'undefined') return null;
  const host = window as Window & {
    SpeechRecognition?: new () => SpeechRecognitionLike;
    webkitSpeechRecognition?: new () => SpeechRecognitionLike;
  };
  return host.SpeechRecognition ?? host.webkitSpeechRecognition ?? null;
}

export function dictateListeningToast(): string {
  return '在听…';
}

export function dictateStoppedToast(): string {
  return '已停住';
}

export function dictateToast(heard?: string | null): string {
  return clipDictateText(heard) ? '已听写入输入框' : '没听清，再说一次';
}

export function dictateUnavailableToast(): string {
  return '这台电脑现在听不了';
}
