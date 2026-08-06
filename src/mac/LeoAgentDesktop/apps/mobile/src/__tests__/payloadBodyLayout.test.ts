import { describe, expect, it } from 'vitest';
import { buildPayloadBodyLayout } from '@/session/payloadBodyLayout';

describe('payloadBodyLayout', () => {
  it('uses compact readable payload dimensions on iPhone SE width', () => {
    expect(buildPayloadBodyLayout({
      kind: 'diff',
      screenWidth: 320,
    })).toEqual({
      actionButtonMinHeight: 40,
      actionButtonMinWidth: 92,
      actionGap: 8,
      bodyPadding: 12,
      compact: true,
      diffContentGap: 8,
      diffLineMinHeight: 22,
      diffLineNumberWidth: 30,
      diffLinePrefixWidth: 12,
      diffPaneGap: 8,
      diffPaneWidth: 276,
      filePreviewMaxHeight: 184,
      mediaFrameMinHeight: 260,
      mediaPlayerMinHeight: 220,
      mediaPlaceholderMinHeight: 220,
      textScrollMaxHeight: 184,
    });
  });

  it('keeps side-by-side diff panes horizontally scrollable on modern iPhones', () => {
    const layout = buildPayloadBodyLayout({
      kind: 'diff',
      screenWidth: 393,
    });

    expect(layout.compact).toBe(false);
    expect(layout.bodyPadding).toBe(16);
    expect(layout.diffPaneGap).toBe(12);
    expect(layout.diffPaneWidth).toBe(329);
    expect(layout.diffPaneWidth * 2 + layout.diffPaneGap).toBeGreaterThan(393 - layout.bodyPadding * 2);
  });

  it('lets larger screens fit both diff panes without an oversized row', () => {
    const layout = buildPayloadBodyLayout({
      kind: 'diff',
      screenWidth: 768,
    });

    expect(layout.compact).toBe(false);
    expect(layout.bodyPadding).toBe(24);
    expect(layout.diffPaneWidth).toBe(352);
    expect(layout.diffPaneWidth * 2 + layout.diffPaneGap).toBe(720);
  });

  it('keeps media metadata shorter than plain text after an inline preview', () => {
    const media = buildPayloadBodyLayout({
      kind: 'media',
      screenWidth: 393,
    });
    const text = buildPayloadBodyLayout({
      kind: 'text',
      screenWidth: 393,
    });

    expect(media.textScrollMaxHeight).toBeLessThan(text.textScrollMaxHeight);
    expect(media.mediaPlaceholderMinHeight).toBe(260);
  });

  it('falls back to the standard phone width before dimensions are ready', () => {
    expect(buildPayloadBodyLayout({
      kind: 'file',
      screenWidth: 0,
    })).toMatchObject({
      bodyPadding: 16,
      compact: false,
      diffPaneWidth: 326,
    });
  });
});
