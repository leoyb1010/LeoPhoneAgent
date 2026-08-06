import { joinChatQuoteTextSegments, parseChatQuoteSegments } from '@cindy/maker-shared/chat-quotes';
import { normalizeRemoteMessages } from '@/session/messageNormalize';
import {
  createSessionLinkPattern,
  parseSessionDeepLinkUrl,
  trimSessionLinkMatch,
} from '@/session/sessionLinks';
import type { RemoteMessage } from '@/session/types';

const MESSAGE_LABEL_MAX_CHARS = 240;

/** Readable text only; never stringify tool/SDK metadata into a reference chip. */
export function mobileSessionMessageDisplayText(message: RemoteMessage): string | null {
  const normalized = normalizeRemoteMessages([message]).find((item) => (
    item.kind === 'user' || item.kind === 'assistant'
  ));
  if (!normalized) return null;
  let text = normalized.body.trim();
  if (normalized.kind === 'user' && normalized.quotesEncoded === true) {
    const segments = parseChatQuoteSegments(normalized.body);
    const hasQuote = segments.some((segment) => segment.kind === 'quote');
    if (hasQuote) text = joinChatQuoteTextSegments(segments).trim();
  }
  if (!text) {
    text = (normalized.attachments ?? []).map((item) => item.name).filter(Boolean).join(' · ');
  }
  return text || null;
}

export function compactSessionMessageLabel(text: string): string {
  const compact = text.replace(/\s+/g, ' ').trim();
  if (compact.length <= MESSAGE_LABEL_MAX_CHARS) return compact;
  return `${compact.slice(0, MESSAGE_LABEL_MAX_CHARS - 1)}…`;
}

export type AnchoredSessionMessageTextPart =
  | { kind: 'text'; text: string }
  | { kind: 'message-link'; url: string; sessionId: string; messageClientId: string };

/** Split only message-anchored session links; whole-session links stay in normal Markdown. */
export function splitAnchoredSessionMessageLinks(text: string): AnchoredSessionMessageTextPart[] {
  const parts: AnchoredSessionMessageTextPart[] = [];
  const pattern = createSessionLinkPattern();
  let cursor = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    const url = trimSessionLinkMatch(match[0]);
    const target = parseSessionDeepLinkUrl(url);
    if (!target?.messageClientId) continue;
    if (match.index > cursor) parts.push({ kind: 'text', text: text.slice(cursor, match.index) });
    parts.push({
      kind: 'message-link',
      url,
      sessionId: target.sessionId,
      messageClientId: target.messageClientId,
    });
    cursor = match.index + url.length;
    pattern.lastIndex = cursor;
  }
  if (cursor < text.length) parts.push({ kind: 'text', text: text.slice(cursor) });
  return parts.length > 0 ? parts : [{ kind: 'text', text }];
}
