export interface SessionChromeLayoutInput {
  actionCount: number;
  screenWidth: number;
}

export interface SessionChromeLayout {
  actionCopyNumberOfLines: number;
  actionGap: number;
  actionPillMinWidth: number;
  actionStripPaddingHorizontal: number;
  compact: boolean;
  fitsPrimaryActions: boolean;
  scrollPaddingRight: number;
}

const DEFAULT_SCREEN_WIDTH = 390;
const COMPACT_WIDTH = 360;
const STANDARD_ACTION_MIN_WIDTH = 60;
const COMPACT_ACTION_MIN_WIDTH = 56;
const MIN_ACTION_MIN_WIDTH = 48;
const STANDARD_HORIZONTAL_PADDING = 12;
const COMPACT_HORIZONTAL_PADDING = 8;
const ACTION_GAP = 4;
const SCROLL_PADDING_RIGHT = 4;

export function buildSessionChromeLayout(input: SessionChromeLayoutInput): SessionChromeLayout {
  const screenWidth = normalizeDimension(input.screenWidth, DEFAULT_SCREEN_WIDTH);
  const actionCount = normalizeActionCount(input.actionCount);
  const compact = screenWidth < COMPACT_WIDTH || !actionsFit({
    actionCount,
    gap: ACTION_GAP,
    minWidth: STANDARD_ACTION_MIN_WIDTH,
    paddingHorizontal: STANDARD_HORIZONTAL_PADDING,
    screenWidth,
    scrollPaddingRight: SCROLL_PADDING_RIGHT,
  });
  const paddingHorizontal = compact ? COMPACT_HORIZONTAL_PADDING : STANDARD_HORIZONTAL_PADDING;
  const standardMinWidth = compact ? COMPACT_ACTION_MIN_WIDTH : STANDARD_ACTION_MIN_WIDTH;
  const actionPillMinWidth = actionCount === 0
    ? standardMinWidth
    : Math.min(
      standardMinWidth,
      Math.max(
        MIN_ACTION_MIN_WIDTH,
        Math.floor(
          (screenWidth - paddingHorizontal * 2 - SCROLL_PADDING_RIGHT - Math.max(actionCount - 1, 0) * ACTION_GAP)
          / actionCount,
        ),
      ),
    );
  const fitsPrimaryActions = actionsFit({
    actionCount,
    gap: ACTION_GAP,
    minWidth: actionPillMinWidth,
    paddingHorizontal,
    screenWidth,
    scrollPaddingRight: SCROLL_PADDING_RIGHT,
  });

  return {
    actionCopyNumberOfLines: 1,
    actionGap: ACTION_GAP,
    actionPillMinWidth,
    actionStripPaddingHorizontal: paddingHorizontal,
    compact,
    fitsPrimaryActions,
    scrollPaddingRight: SCROLL_PADDING_RIGHT,
  };
}

function actionsFit({
  actionCount,
  gap,
  minWidth,
  paddingHorizontal,
  screenWidth,
  scrollPaddingRight,
}: {
  actionCount: number;
  gap: number;
  minWidth: number;
  paddingHorizontal: number;
  screenWidth: number;
  scrollPaddingRight: number;
}): boolean {
  if (actionCount <= 0) return true;
  const availableWidth = Math.max(0, screenWidth - paddingHorizontal * 2);
  const requiredWidth = actionCount * minWidth + Math.max(actionCount - 1, 0) * gap + scrollPaddingRight;
  return requiredWidth <= availableWidth;
}

function normalizeActionCount(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.floor(value);
}

function normalizeDimension(value: number, fallback: number): number {
  return Number.isFinite(value) && value > 0 ? value : fallback;
}
