import { api } from './api';
import { clipTalkUrl } from './session-links';
import { clipSpeakText } from './session-speak';

type DesktopFolderTools = {
  pickFolder?: () => Promise<{ path?: string; cancelled?: boolean }>;
  revealPath?: (target: string) => Promise<unknown>;
  openPath?: (target: string) => Promise<unknown>;
  openTerm?: (target: string) => Promise<unknown>;
  openUrl?: (target: string) => Promise<unknown>;
  speakText?: (text: string) => Promise<unknown>;
};

function desktopTools(): DesktopFolderTools | undefined {
  if (typeof window === 'undefined') return undefined;
  return window.leocodeboxDesktopTools;
}

export async function pickSessionFolder(): Promise<string | null> {
  const desktop = desktopTools()?.pickFolder;
  if (desktop) {
    const row = await desktop();
    if (row?.cancelled) return null;
    if (row?.path?.trim()) return row.path.trim();
  }
  const row = await api.pickLocalFolder();
  if ('cancelled' in row && row.cancelled) return null;
  return 'path' in row ? row.path : null;
}

export async function revealSessionPath(target: string): Promise<void> {
  const next = target.trim();
  if (!next) throw new Error('没有路径');
  const desktop = desktopTools()?.revealPath;
  if (desktop) {
    await desktop(next);
    return;
  }
  await api.revealLocalPath(next);
}

export function canOpenSessionPath(machine?: string | null, target?: string | null): boolean {
  return machine === 'local' && Boolean(target?.trim());
}

export async function openSessionPath(target: string): Promise<void> {
  const next = target.trim();
  if (!next) throw new Error('没有路径');
  const desktop = desktopTools()?.openPath;
  if (desktop) {
    await desktop(next);
    return;
  }
  await api.openLocalPath(next);
}

export async function openSessionUrl(target: string): Promise<void> {
  const next = clipTalkUrl(target);
  if (!next) throw new Error('这个链接不能打开');
  const desktop = desktopTools()?.openUrl;
  if (desktop) {
    await desktop(next);
    return;
  }
  if (typeof window !== 'undefined') {
    window.open(next, '_blank', 'noopener,noreferrer');
    return;
  }
  throw new Error('打不开这个链接');
}

export async function speakSessionText(text: string): Promise<void> {
  const next = clipSpeakText(text);
  if (!next) throw new Error('没有可读的字');
  const desktop = desktopTools()?.speakText;
  if (desktop) {
    await desktop(next);
    return;
  }
  const synth = typeof window !== 'undefined' ? window.speechSynthesis : undefined;
  if (!synth) throw new Error('只有装好的桌面端才能读出来');
  synth.cancel();
  const utterance = new SpeechSynthesisUtterance(next);
  utterance.lang = 'zh-CN';
  const voice = synth.getVoices().find((row) => /zh|Chinese|Ting|Meijia|Sinji/i.test(`${row.lang} ${row.name}`));
  if (voice) utterance.voice = voice;
  synth.speak(utterance);
}

export async function openSessionTerm(target: string): Promise<void> {
  const next = target.trim();
  if (!next) throw new Error('没有路径');
  const desktop = desktopTools()?.openTerm;
  if (desktop) {
    await desktop(next);
    return;
  }
  await api.openLocalTerminal(next);
}
