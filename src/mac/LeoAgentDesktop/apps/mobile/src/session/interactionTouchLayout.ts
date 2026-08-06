export interface InteractionTouchLayoutInput {
  actionCount: number;
  screenWidth: number;
}

export interface InteractionTouchLayout {
  actionButtonMinHeight: number;
  actionButtonMinWidth: number;
  actionGap: number;
  cardGap: number;
  cardPadding: number;
  compact: boolean;
  inlineButtonMinWidth: number;
  optionRowMinHeight: number;
  planPreviewMaxHeight: number;
  planPreviewFullMinHeight: number;
  rootGap: number;
  rootPaddingHorizontal: number;
  stackInlineInputRows: boolean;
  taskCountPillMinHeight: number;
  taskHeaderGap: number;
  taskHeaderMinHeight: number;
}

const DEFAULT_SCREEN_WIDTH = 390;
const COMPACT_WIDTH = 360;
const STACK_INLINE_WIDTH = 340;
const STANDARD_PADDING = 16;
const COMPACT_PADDING = 12;
const STANDARD_GAP = 8;
const COMPACT_GAP = 4;
const ACTION_TOUCH_HEIGHT = 44;
const OPTION_TOUCH_HEIGHT = 52;
const COMPACT_OPTION_TOUCH_HEIGHT = 48;

export function buildInteractionTouchLayout(input: InteractionTouchLayoutInput): InteractionTouchLayout {
  const screenWidth = normalizeDimension(input.screenWidth, DEFAULT_SCREEN_WIDTH);
  const actionCount = normalizeCount(input.actionCount);
  const compact = screenWidth <= COMPACT_WIDTH || actionCount > 3;
  const stackInlineInputRows = screenWidth <= STACK_INLINE_WIDTH;

  return {
    actionButtonMinHeight: ACTION_TOUCH_HEIGHT,
    actionButtonMinWidth: compact ? 76 : 88,
    actionGap: compact ? COMPACT_GAP : STANDARD_GAP,
    cardGap: compact ? COMPACT_GAP : STANDARD_GAP,
    cardPadding: compact ? COMPACT_PADDING : STANDARD_PADDING,
    compact,
    inlineButtonMinWidth: compact ? 68 : 76,
    optionRowMinHeight: compact ? COMPACT_OPTION_TOUCH_HEIGHT : OPTION_TOUCH_HEIGHT,
    planPreviewMaxHeight: compact ? 208 : 240,
    planPreviewFullMinHeight: compact ? 320 : 380,
    rootGap: compact ? COMPACT_GAP : STANDARD_GAP,
    rootPaddingHorizontal: compact ? COMPACT_PADDING : STANDARD_PADDING,
    stackInlineInputRows,
    taskCountPillMinHeight: ACTION_TOUCH_HEIGHT,
    taskHeaderGap: compact ? COMPACT_GAP : STANDARD_GAP,
    taskHeaderMinHeight: ACTION_TOUCH_HEIGHT,
  };
}

function normalizeCount(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.floor(value);
}

function normalizeDimension(value: number, fallback: number): number {
  return Number.isFinite(value) && value > 0 ? value : fallback;
}
