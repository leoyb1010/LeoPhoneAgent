import { describe, expect, it } from 'vitest';

import {
  attachSessionReferenceMetadata,
  parsePersistedSessionReferenceMetadata,
} from '../sessionReferenceMetadata';

describe('sessionReferenceMetadata', () => {
  it('attaches display-safe summaries without persisting referenced bodies', () => {
    const content = JSON.stringify({ text: 'See cindy://session/s-1', images: [], files: [] });
    const result = JSON.parse(
      attachSessionReferenceMetadata(content, [
        {
          sessionId: 's-1',
          range: 'recent',
          messageCount: 12,
          truncated: true,
        },
      ]),
    ) as Record<string, unknown>;

    expect(result.sessionReferences).toEqual([
      {
        sessionId: 's-1',
        range: 'recent',
        messageCount: 12,
        truncated: true,
      },
    ]);
    expect(JSON.stringify(result)).not.toContain('referenced message body');
  });

  it('keeps anchor identity and around-anchor range', () => {
    expect(
      parsePersistedSessionReferenceMetadata([
        {
          sessionId: 's-2',
          messageClientId: 'm-9',
          range: 'around-anchor',
          messageCount: 7,
          truncated: false,
        },
      ]),
    ).toEqual([
      {
        sessionId: 's-2',
        messageClientId: 'm-9',
        range: 'around-anchor',
        messageCount: 7,
        truncated: false,
      },
    ]);
  });

  it('rejects the whole metadata set when an entry has an invalid shape', () => {
    expect(
      parsePersistedSessionReferenceMetadata([
        { sessionId: 's-1', range: 'recent', messageCount: 3, truncated: false },
        { sessionId: 's-2', range: 'recent', messageCount: 21, truncated: false },
      ]),
    ).toEqual([]);
  });

  it('does not rewrite malformed legacy content', () => {
    expect(
      attachSessionReferenceMetadata('legacy plain text', [
        { sessionId: 's-1', range: 'recent', messageCount: 3, truncated: false },
      ]),
    ).toBe('legacy plain text');
  });

  it('clears stale summaries when edited content no longer has session references', () => {
    const content = JSON.stringify({
      text: 'Link removed',
      images: [],
      files: [],
      sessionReferences: [
        { sessionId: 's-1', range: 'recent', messageCount: 3, truncated: false },
      ],
    });

    expect(JSON.parse(attachSessionReferenceMetadata(content, []))).toEqual({
      text: 'Link removed',
      images: [],
      files: [],
    });
  });
});
