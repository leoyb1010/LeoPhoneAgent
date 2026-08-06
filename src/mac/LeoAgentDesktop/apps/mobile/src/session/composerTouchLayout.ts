export interface ComposerTouchLayoutInput {
  screenWidth: number;
}

export interface ComposerTouchLayout {
  attachmentActionMinWidth: number;
  attachmentAddButtonMinWidth: number;
  attachmentPathGap: number;
  attachmentQuickActionGap: number;
  compact: boolean;
  composerPaddingHorizontal: number;
  stackAttachmentPathRow: boolean;
  statusNumberOfLines: number;
}

const DEFAULT_SCREEN_WIDTH = 390;
const COMPACT_WIDTH = 380;
const STACKED_PATH_WIDTH = 390;
const STANDARD_GAP = 8;
const COMPACT_GAP = 4;

export function buildComposerTouchLayout(input: ComposerTouchLayoutInput): ComposerTouchLayout {
  const screenWidth = normalizeDimension(input.screenWidth, DEFAULT_SCREEN_WIDTH);
  const compact = screenWidth < COMPACT_WIDTH;
  const stackAttachmentPathRow = screenWidth < STACKED_PATH_WIDTH;

  return {
    attachmentActionMinWidth: compact ? 0 : 92,
    attachmentAddButtonMinWidth: stackAttachmentPathRow ? 0 : 64,
    attachmentPathGap: stackAttachmentPathRow ? COMPACT_GAP : STANDARD_GAP,
    attachmentQuickActionGap: compact ? COMPACT_GAP : STANDARD_GAP,
    compact,
    composerPaddingHorizontal: compact ? 12 : 16,
    stackAttachmentPathRow,
    statusNumberOfLines: compact ? 2 : 1,
  };
}

function normalizeDimension(value: number, fallback: number): number {
  return Number.isFinite(value) && value > 0 ? value : fallback;
}
