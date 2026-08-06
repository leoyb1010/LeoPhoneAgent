// @vitest-environment jsdom

import { describe, expect, it, vi } from 'vitest';

import {
  insertSessionLinkIntoComposer,
  subscribeSessionLinkInsert,
} from '@/lib/composerActionsBus';

describe('composerActionsBus', () => {
  it('delivers session-link insert requests and supports unsubscribe', () => {
    const handler = vi.fn();
    const unsubscribe = subscribeSessionLinkInsert(handler);
    const detail = {
      targetSessionId: 'session-a',
      href: 'cindy://session/session-a?message=message-a',
    };

    insertSessionLinkIntoComposer(detail);
    expect(handler).toHaveBeenCalledWith(detail);

    unsubscribe();
    insertSessionLinkIntoComposer(detail);
    expect(handler).toHaveBeenCalledTimes(1);
  });
});
