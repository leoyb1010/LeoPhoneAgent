import { describe, expect, it } from 'vitest';
import { formatQuoteForSend } from '@cindy/maker-shared/chat-quotes';
import {
  mobileSessionMessageDisplayText,
  splitAnchoredSessionMessageLinks,
} from '@/session/sessionMessageText';
import type { RemoteMessage } from '@/session/types';

function message(input: Partial<RemoteMessage>): RemoteMessage {
  return { id: 'm', role: 'user', content: '', createdAt: '2026-07-23T00:00:00Z', ...input } as RemoteMessage;
}

describe('mobile session message labels', () => {
  it('uses visible prose and hides quote markers', () => {
    expect(mobileSessionMessageDisplayText(message({
      content: JSON.stringify({
        text: `${formatQuoteForSend({ text: 'source' })}\n\nanswer`,
        quotesEncoded: true,
      }),
    }))).toBe('answer');
  });

  it('does not stringify tool metadata', () => {
    expect(mobileSessionMessageDisplayText(message({ role: 'tool_use', content: { secret: true } }))).toBeNull();
  });

  it('splits message anchors while preserving adjacent punctuation and whole-session links', () => {
    expect(splitAnchoredSessionMessageLinks(
      'See cindy://session/s-1?message=m-2, then cindy://session/s-3.',
    )).toEqual([
      { kind: 'text', text: 'See ' },
      {
        kind: 'message-link',
        url: 'cindy://session/s-1?message=m-2',
        sessionId: 's-1',
        messageClientId: 'm-2',
      },
      { kind: 'text', text: ', then cindy://session/s-3.' },
    ]);
  });
});
