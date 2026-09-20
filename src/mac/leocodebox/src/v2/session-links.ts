import type { FlowRow } from './model';

export const TALK_LINK_MAX = 20;

export function clipTalkUrl(raw?: string | null): string {
  let next = (raw ?? '').replace(/\u0000/g, '').trim();
  if (!next || next.length > 500) return '';
  next = next.replace(/[.,;:!?，。；）】)>\]]+$/g, '');
  if (/^(localhost|127\.0\.0\.1):\d{2,5}\b/i.test(next)) next = `http://${next}`;
  let parsed: URL;
  try {
    parsed = new URL(next);
  } catch {
    return '';
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return '';
  if (parsed.username || parsed.password) return '';
  return parsed.href;
}

const URL_RE = /\b((?:https?:\/\/|localhost:|127\.0\.0\.1:)\S+)/gi;

export function talkLinksFromText(text?: string | null): string[] {
  const src = (text ?? '').slice(0, 4000);
  const out: string[] = [];
  for (const match of src.matchAll(URL_RE)) {
    const url = clipTalkUrl(match[1]);
    if (url && !out.includes(url)) out.push(url);
  }
  return out;
}

export function talkLinkLabel(url: string): string {
  try {
    const parsed = new URL(url);
    const path = `${parsed.host}${parsed.pathname === '/' ? '' : parsed.pathname}`.replace(/\/$/, '');
    return path.length > 48 ? `${path.slice(0, 47)}…` : path || url;
  } catch {
    return url;
  }
}

export type TalkLink = { url: string; label: string };

export function sessionTalkLinks(rows?: readonly FlowRow[] | null): TalkLink[] {
  const seen = new Set<string>();
  const out: TalkLink[] = [];
  for (const row of rows ?? []) {
    const texts: string[] = [];
    if (row.k === 'user' || row.k === 'ai' || row.k === 'sys') texts.push(row.text);
    else if (row.k === 'tool') texts.push(row.preview, row.output);
    for (const text of texts) {
      for (const url of talkLinksFromText(text)) {
        if (seen.has(url)) continue;
        seen.add(url);
        out.push({ url, label: talkLinkLabel(url) });
        if (out.length >= TALK_LINK_MAX) return out;
      }
    }
  }
  return out;
}

export function canOpenTalkLinks(machine?: string | null, links?: readonly unknown[] | null): boolean {
  return machine === 'local' && Boolean(links?.length);
}

export function talkLinkPickerHint(count: number): string {
  if (count <= 0) return '这条没有链接';
  return count === 1 ? '1 个链接' : `${count} 个链接`;
}

export function talkLinkToast(url?: string | null): string {
  const label = talkLinkLabel(clipTalkUrl(url) || (url ?? '').trim());
  return label ? `已打开 ${label}` : '已打开链接';
}
