import { describe, expect, it } from 'vitest';

import {
  buildSentInlineTokens,
  locateChatQuoteTextSegmentStarts,
  projectSentRanges,
} from '@/components/chat/UserMessage';
import { formatQuoteForSend, parseChatQuoteSegments } from '@/lib/chatQuotes';
import type { SlashCommandRange } from '@/lib/imageRef';

describe('sent slash command presentation ranges', () => {
  it('keeps both /git chips around an inline quote at their exact source positions', () => {
    const quote = formatQuoteForSend({ text: 'quoted selection' });
    const content = `/git before\n\n${quote}\n\n/git after`;
    const secondStart = content.lastIndexOf('/git');
    const ranges: SlashCommandRange[] = [
      { start: 0, end: 4 },
      { start: secondStart, end: secondStart + 4 },
    ];
    const segments = parseChatQuoteSegments(content);
    const starts = locateChatQuoteTextSegmentStarts(content, segments);
    const textSegments = segments
      .map((segment, index) => ({ segment, start: starts[index] }))
      .filter(
        (item): item is { segment: { kind: 'text'; text: string }; start: number } =>
          item.segment.kind === 'text' && item.start !== null,
      );

    expect(
      textSegments.map(({ segment, start }) =>
        buildSentInlineTokens(
          segment.text,
          [],
          projectSentRanges(ranges, start, segment.text.length),
        )
          .filter((token) => token.kind === 'slash')
          .map((token) => token.text),
      ),
    ).toEqual([['/git'], ['/git']]);
  });

  it('keeps a slash chip after a leading quote and inside ordinary prose', () => {
    const quote = formatQuoteForSend({ text: 'quoted selection' });
    const content = `${quote}\n\nreply /git here`;
    const start = content.indexOf('/git');
    const ranges = [{ start, end: start + 4 }];
    const segments = parseChatQuoteSegments(content);
    const starts = locateChatQuoteTextSegmentStarts(content, segments);
    const textIndex = segments.findIndex((segment) => segment.kind === 'text');
    const textSegment = segments[textIndex];

    expect(textSegment.kind).toBe('text');
    if (textSegment.kind !== 'text') return;
    expect(
      buildSentInlineTokens(
        textSegment.text,
        [],
        projectSentRanges(ranges, starts[textIndex], textSegment.text.length),
      ),
    ).toEqual([
      { kind: 'text', text: 'reply ' },
      { kind: 'slash', text: '/git' },
      { kind: 'text', text: ' here' },
    ]);
  });

  it('supports multiple lines and does not promote an unknown /foo without a range', () => {
    const content = 'prefix /git\n/help tail\n/foo';
    const ranges = [
      { start: content.indexOf('/git'), end: content.indexOf('/git') + 4 },
      { start: content.indexOf('/help'), end: content.indexOf('/help') + 5 },
    ];

    expect(
      buildSentInlineTokens(content, [], ranges).filter((token) => token.kind === 'slash'),
    ).toEqual([
      { kind: 'slash', text: '/git' },
      { kind: 'slash', text: '/help' },
    ]);
    expect(buildSentInlineTokens('/foo', [], [])).toEqual([{ kind: 'text', text: '/foo' }]);
  });
});
