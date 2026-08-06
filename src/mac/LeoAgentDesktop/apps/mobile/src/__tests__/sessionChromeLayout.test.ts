import { describe, expect, it } from 'vitest';
import { buildSessionChromeLayout } from '@/session/sessionChromeLayout';

describe('sessionChromeLayout', () => {
  it('keeps five primary actions visible on iPhone SE width without platform branches', () => {
    const layout = buildSessionChromeLayout({
      actionCount: 5,
      screenWidth: 320,
    });

    expect(layout).toEqual({
      actionCopyNumberOfLines: 1,
      actionGap: 4,
      actionPillMinWidth: 56,
      actionStripPaddingHorizontal: 8,
      compact: true,
      fitsPrimaryActions: true,
      scrollPaddingRight: 4,
    });
  });

  it('uses stable spacing on modern iPhone widths', () => {
    const layout = buildSessionChromeLayout({
      actionCount: 5,
      screenWidth: 393,
    });

    expect(layout).toEqual({
      actionCopyNumberOfLines: 1,
      actionGap: 4,
      actionPillMinWidth: 60,
      actionStripPaddingHorizontal: 12,
      compact: false,
      fitsPrimaryActions: true,
      scrollPaddingRight: 4,
    });
  });

  it('falls back to the standard phone width before dimensions are ready', () => {
    expect(buildSessionChromeLayout({ actionCount: 5, screenWidth: 0 })).toMatchObject({
      actionPillMinWidth: 60,
      actionStripPaddingHorizontal: 12,
      compact: false,
      fitsPrimaryActions: true,
    });
  });

  it('keeps an explicit overflow signal for widths too narrow to guarantee all actions', () => {
    const layout = buildSessionChromeLayout({
      actionCount: 7,
      screenWidth: 280,
    });

    expect(layout.compact).toBe(true);
    expect(layout.actionPillMinWidth).toBe(48);
    expect(layout.fitsPrimaryActions).toBe(false);
  });
});
