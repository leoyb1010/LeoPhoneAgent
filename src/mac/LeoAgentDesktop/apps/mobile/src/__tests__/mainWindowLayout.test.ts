import { describe, expect, it } from 'vitest';
import { buildMainWindowLayout } from '@/components/mainWindowLayout';

describe('mainWindowLayout', () => {
  it('compacts primary windows on iPhone SE width without platform branches', () => {
    expect(buildMainWindowLayout({
      actionCount: 1,
      kind: 'detail',
      metricCount: 4,
      screenWidth: 320,
    })).toEqual({
      blockGap: 6,
      blockPadding: 12,
      compact: true,
      contentGap: 8,
      contentPaddingHorizontal: 12,
      contentPaddingVertical: 12,
      emptyMinHeight: 132,
      emptyPadding: 12,
      inlineActionMinHeight: 38,
      inlineActionMinWidth: 74,
      listPaddingHorizontal: 12,
      listPaddingVertical: 8,
      listSeparatorInset: 20,
      metricGap: 6,
      metricMinHeight: 36,
      metricMinWidth: 88,
      stackInlineRows: true,
      summaryGap: 8,
      toolbarGap: 8,
      toolbarMinHeight: 52,
      toolbarPaddingHorizontal: 12,
      toolbarPaddingVertical: 8,
    });
  });

  it('keeps regular spacing on modern iPhone widths', () => {
    expect(buildMainWindowLayout({
      kind: 'list',
      metricCount: 2,
      screenWidth: 393,
    })).toMatchObject({
      blockPadding: 16,
      compact: false,
      contentGap: 12,
      emptyMinHeight: 176,
      listPaddingHorizontal: 16,
      metricMinHeight: 38,
      metricMinWidth: 96,
      stackInlineRows: false,
      toolbarMinHeight: 56,
    });
  });

  it('uses slightly roomier form rhythm for form and browser windows', () => {
    const form = buildMainWindowLayout({
      kind: 'form',
      metricCount: 3,
      screenWidth: 393,
    });
    const browser = buildMainWindowLayout({
      kind: 'browser',
      screenWidth: 393,
    });

    expect(form.contentGap).toBe(16);
    expect(form.metricMinHeight).toBe(62);
    expect(browser.blockGap).toBe(12);
  });

  it('falls back before dimensions are ready', () => {
    expect(buildMainWindowLayout({ kind: 'detail', screenWidth: 0 })).toMatchObject({
      compact: false,
      contentPaddingHorizontal: 16,
      toolbarPaddingHorizontal: 16,
    });
  });
});
