import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  aroundMessagesByClientIdFor: vi.fn(),
}));

vi.mock('@/lib/makerTransport', () => ({
  aroundMessagesByClientIdFor: mocks.aroundMessagesByClientIdFor,
}));

import type { Message } from '@/lib/ccAgent.types';
import { resolveSessionMessageText, sessionMessageDisplayText } from '@/lib/sessionMessageText';

function message(overrides: Partial<Message>): Message {
  return {
    id: 'row-1',
    clientId: 'client-1',
    sessionId: 'session-1',
    role: 'user',
    content: 'hello',
    toolUseId: null,
    agentMeta: null,
    createdAt: '2026-07-22T00:00:00.000Z',
    ...overrides,
  };
}

describe('sessionMessageDisplayText', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('reads user text and hides private quote markers', () => {
    expect(
      sessionMessageDisplayText(
        message({
          content: JSON.stringify({
            text: '> <!-- cindy-composer-quote -->\n> quoted text\n\nreply',
            images: [],
            files: [],
            quotesEncoded: true,
          }),
        }),
      ),
    ).toBe('> quoted text\n\nreply');
  });

  it('uses attachment names when a user message has no text', () => {
    expect(
      sessionMessageDisplayText(
        message({
          content: { text: '', images: [], files: [{ name: 'brief.pdf', path: '/brief.pdf' }] },
        }),
      ),
    ).toBe('brief.pdf');
  });

  it('reads assistant prose but never stringifies structured tool rows', () => {
    expect(sessionMessageDisplayText(message({ role: 'assistant', content: '  answer  ' }))).toBe(
      'answer',
    );
    expect(
      sessionMessageDisplayText(message({ role: 'tool_result', content: { output: 'secret' } })),
    ).toBeNull();
  });

  it('fetches only the anchored row and selects the matching client id', async () => {
    mocks.aroundMessagesByClientIdFor.mockResolvedValue([
      message({ clientId: 'other', content: 'other' }),
      message({ clientId: 'target', content: 'target body' }),
    ]);

    await expect(resolveSessionMessageText('session-1', 'target')).resolves.toBe('target body');
    expect(mocks.aroundMessagesByClientIdFor).toHaveBeenCalledWith('session-1', 'target', {
      radius: 0,
    });
  });
});
