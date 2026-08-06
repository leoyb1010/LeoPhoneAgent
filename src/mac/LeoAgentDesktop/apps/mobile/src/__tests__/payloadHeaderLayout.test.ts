import { describe, expect, it } from 'vitest';
import { buildPayloadHeaderLayout, buildPayloadModalSafeArea } from '@/session/payloadHeaderLayout';

describe('payloadHeaderLayout', () => {
  it('keeps dense payload icon actions side-by-side on iPhone SE width', () => {
    const layout = buildPayloadHeaderLayout({
      canCopy: true,
      canOpen: true,
      canPageGallery: true,
      screenHeight: 568,
      screenWidth: 320,
    });

    expect(layout).toEqual({
      actionButtonMinWidth: 36,
      actionGap: 4,
      actionsAlignItems: 'flex-end',
      actionsDirection: 'column',
      actionsWidth: 'auto',
      closeButtonMinWidth: 40,
      compact: false,
      galleryButtonMinWidth: 36,
      headerDirection: 'row',
      headerGap: 12,
      headerMinHeight: 72,
      headerPaddingHorizontal: 16,
      landscape: false,
      primaryActionsJustifyContent: 'flex-end',
      showSubtitle: true,
      titleNumberOfLines: 2,
    });
  });

  it('keeps sparse payload headers side-by-side on modern iPhones', () => {
    const layout = buildPayloadHeaderLayout({
      canCopy: false,
      canOpen: false,
      canPageGallery: false,
      screenHeight: 852,
      screenWidth: 393,
    });

    expect(layout).toMatchObject({
      actionsAlignItems: 'flex-end',
      actionsWidth: 'auto',
      compact: false,
      headerDirection: 'row',
      headerPaddingHorizontal: 16,
      primaryActionsJustifyContent: 'flex-end',
    });
  });

  it('stacks only when dense icon actions would leave too little title width', () => {
    const layout = buildPayloadHeaderLayout({
      canCopy: true,
      canOpen: true,
      canPageGallery: true,
      screenHeight: 480,
      screenWidth: 280,
    });

    expect(layout.compact).toBe(true);
    expect(layout.headerDirection).toBe('column');
  });

  it('collapses to a compact single-line header in landscape', () => {
    // 横屏:标题单行、副标题隐藏、actions 收成一行、header 最小高度压缩——
    // 纵向空间全部让给 body(图表)。
    const layout = buildPayloadHeaderLayout({
      canCopy: true,
      canOpen: false,
      canPageGallery: false,
      screenHeight: 402,
      screenWidth: 874,
    });

    expect(layout).toMatchObject({
      actionsAlignItems: 'center',
      actionsDirection: 'row',
      compact: false,
      headerDirection: 'row',
      headerMinHeight: 48,
      landscape: true,
      showSubtitle: false,
      titleNumberOfLines: 1,
    });
  });

  it('falls back to the standard phone width before dimensions are ready', () => {
    const layout = buildPayloadHeaderLayout({
      canCopy: false,
      canOpen: false,
      canPageGallery: false,
      screenHeight: 0,
      screenWidth: 0,
    });
    expect(layout.compact).toBe(false);
    expect(layout.landscape).toBe(false);
  });

  it('keeps full-screen payload modals below the iOS status bar when modal insets are missing', () => {
    expect(buildPayloadModalSafeArea({
      platform: 'ios',
      safeAreaTop: 0,
      safeAreaBottom: 0,
    })).toEqual({
      paddingBottom: 24,
      paddingTop: 56,
    });
  });

  it('shrinks iOS fallbacks in landscape where the status bar is hidden', () => {
    expect(buildPayloadModalSafeArea({
      landscape: true,
      platform: 'ios',
      safeAreaTop: 0,
      safeAreaBottom: 0,
    })).toEqual({
      paddingBottom: 12,
      paddingTop: 12,
    });
  });

  it('respects measured safe area insets when they are larger than fallbacks', () => {
    expect(buildPayloadModalSafeArea({
      platform: 'ios',
      safeAreaTop: 64,
      safeAreaBottom: 34,
    })).toEqual({
      paddingBottom: 34,
      paddingTop: 64,
    });
  });

  it('uses the Android status bar height without adding iOS bottom padding', () => {
    expect(buildPayloadModalSafeArea({
      androidStatusBarHeight: 28,
      platform: 'android',
      safeAreaTop: 0,
      safeAreaBottom: 0,
    })).toEqual({
      paddingBottom: 0,
      paddingTop: 28,
    });
  });
});
