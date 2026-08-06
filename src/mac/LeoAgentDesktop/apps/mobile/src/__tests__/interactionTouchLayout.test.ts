import { describe, expect, it } from 'vitest';
import { buildInteractionTouchLayout } from '@/session/interactionTouchLayout';

describe('interactionTouchLayout', () => {
  it('compacts pending actions and stacks inline inputs on iPhone SE width', () => {
    expect(buildInteractionTouchLayout({
      actionCount: 3,
      screenWidth: 320,
    })).toEqual({
      actionButtonMinHeight: 44,
      actionButtonMinWidth: 76,
      actionGap: 4,
      cardGap: 4,
      cardPadding: 12,
      compact: true,
      inlineButtonMinWidth: 68,
      optionRowMinHeight: 48,
      planPreviewFullMinHeight: 320,
      planPreviewMaxHeight: 208,
      rootGap: 4,
      rootPaddingHorizontal: 12,
      stackInlineInputRows: true,
      taskCountPillMinHeight: 44,
      taskHeaderGap: 4,
      taskHeaderMinHeight: 44,
    });
  });

  it('uses roomier touch rhythm on modern iPhones', () => {
    expect(buildInteractionTouchLayout({
      actionCount: 2,
      screenWidth: 393,
    })).toEqual({
      actionButtonMinHeight: 44,
      actionButtonMinWidth: 88,
      actionGap: 8,
      cardGap: 8,
      cardPadding: 16,
      compact: false,
      inlineButtonMinWidth: 76,
      optionRowMinHeight: 52,
      planPreviewFullMinHeight: 380,
      planPreviewMaxHeight: 240,
      rootGap: 8,
      rootPaddingHorizontal: 16,
      stackInlineInputRows: false,
      taskCountPillMinHeight: 44,
      taskHeaderGap: 8,
      taskHeaderMinHeight: 44,
    });
  });

  it('falls back to standard phone width before dimensions are ready', () => {
    expect(buildInteractionTouchLayout({
      actionCount: 2,
      screenWidth: 0,
    })).toMatchObject({
      compact: false,
      rootPaddingHorizontal: 16,
      stackInlineInputRows: false,
    });
  });
});
