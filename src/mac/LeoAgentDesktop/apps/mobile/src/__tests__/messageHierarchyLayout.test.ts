import { describe, expect, it } from 'vitest';
import { buildMessageHierarchyLayout } from '@/session/messageHierarchyLayout';

describe('messageHierarchyLayout', () => {
  it('compacts foldable work panels on iPhone SE width', () => {
    expect(buildMessageHierarchyLayout({
      screenWidth: 320,
      summaryCount: 4,
    })).toEqual({
      compact: true,
      foldBodyPaddingBottom: 12,
      foldBodyPaddingHorizontal: 12,
      foldHeaderGap: 8,
      foldHeaderMinHeight: 42,
      foldHeaderPaddingHorizontal: 12,
      foldHeaderPaddingVertical: 8,
      railPaddingLeft: 10,
      stackGap: 8,
      stackSmallGap: 6,
      todoMarkWidth: 20,
      todoRowGap: 6,
      todoRowMinHeight: 40,
      todoSummaryInset: 26,
    });
  });

  it('keeps regular spacing for sparse modern iPhone panels', () => {
    expect(buildMessageHierarchyLayout({
      screenWidth: 393,
      summaryCount: 2,
    })).toMatchObject({
      compact: false,
      foldHeaderMinHeight: 46,
      todoRowMinHeight: 44,
    });
  });

  it('compacts dense summaries without reintroducing tool signal chip layout', () => {
    const layout = buildMessageHierarchyLayout({
      screenWidth: 393,
      summaryCount: 4,
    });

    expect(layout.compact).toBe(true);
    expect('toolSignalGap' in layout).toBe(false);
    expect('badgeGap' in layout).toBe(false);
  });

  it('falls back to standard phone width before dimensions are ready', () => {
    expect(buildMessageHierarchyLayout({
      screenWidth: 0,
      summaryCount: 0,
    })).toMatchObject({
      compact: false,
      foldBodyPaddingHorizontal: 16,
    });
  });
});
