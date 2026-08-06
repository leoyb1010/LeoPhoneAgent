import { describe, expect, it } from 'vitest';
import { buildComposerTouchLayout } from '@/session/composerTouchLayout';

describe('composerTouchLayout', () => {
  it('keeps iPhone SE width controls flexible and stacks the remote path row', () => {
    const layout = buildComposerTouchLayout({ screenWidth: 320 });

    expect(layout).toEqual({
      attachmentActionMinWidth: 0,
      attachmentAddButtonMinWidth: 0,
      attachmentPathGap: 4,
      attachmentQuickActionGap: 4,
      compact: true,
      composerPaddingHorizontal: 12,
      stackAttachmentPathRow: true,
      statusNumberOfLines: 2,
    });
  });

  it('uses single-line status and stable pill widths on modern iPhones', () => {
    const layout = buildComposerTouchLayout({ screenWidth: 393 });

    expect(layout).toEqual({
      attachmentActionMinWidth: 92,
      attachmentAddButtonMinWidth: 64,
      attachmentPathGap: 8,
      attachmentQuickActionGap: 8,
      compact: false,
      composerPaddingHorizontal: 16,
      stackAttachmentPathRow: false,
      statusNumberOfLines: 1,
    });
  });

  it('stacks remote path controls before the rest of the composer becomes compact', () => {
    const layout = buildComposerTouchLayout({ screenWidth: 384 });

    expect(layout.compact).toBe(false);
    expect(layout.stackAttachmentPathRow).toBe(true);
    expect(layout.attachmentAddButtonMinWidth).toBe(0);
    expect(layout.attachmentPathGap).toBe(4);
  });

  it('falls back to the standard iPhone width when dimensions are not ready', () => {
    expect(buildComposerTouchLayout({ screenWidth: 0 })).toMatchObject({
      compact: false,
      stackAttachmentPathRow: false,
    });
  });
});
