export type MainWindowKind = 'list' | 'detail' | 'form' | 'browser';

export interface MainWindowLayoutInput {
  actionCount?: number;
  kind?: MainWindowKind;
  metricCount?: number;
  screenWidth: number;
}

export interface MainWindowLayout {
  blockGap: number;
  blockPadding: number;
  compact: boolean;
  contentGap: number;
  contentPaddingHorizontal: number;
  contentPaddingVertical: number;
  emptyMinHeight: number;
  emptyPadding: number;
  inlineActionMinHeight: number;
  inlineActionMinWidth: number;
  listPaddingHorizontal: number;
  listPaddingVertical: number;
  listSeparatorInset: number;
  metricGap: number;
  metricMinHeight: number;
  metricMinWidth: number;
  stackInlineRows: boolean;
  summaryGap: number;
  toolbarGap: number;
  toolbarMinHeight: number;
  toolbarPaddingHorizontal: number;
  toolbarPaddingVertical: number;
}

const DEFAULT_SCREEN_WIDTH = 390;
const COMPACT_WIDTH = 360;
const STACK_INLINE_WIDTH = 340;
const STANDARD_PADDING = 16;
const COMPACT_PADDING = 12;
const STANDARD_GAP = 12;
const COMPACT_GAP = 8;

export function buildMainWindowLayout(input: MainWindowLayoutInput): MainWindowLayout {
  const screenWidth = normalizeDimension(input.screenWidth, DEFAULT_SCREEN_WIDTH);
  const metricCount = normalizeCount(input.metricCount);
  const actionCount = normalizeCount(input.actionCount);
  const compact = screenWidth <= COMPACT_WIDTH || (metricCount + actionCount >= 4 && screenWidth < 400);
  const stackInlineRows = screenWidth <= STACK_INLINE_WIDTH;
  const padding = compact ? COMPACT_PADDING : STANDARD_PADDING;
  const gap = compact ? COMPACT_GAP : STANDARD_GAP;
  const kind = input.kind ?? 'detail';
  const formDense = kind === 'form' || kind === 'browser';

  return {
    blockGap: formDense ? gap : Math.max(gap - 4, 6),
    blockPadding: padding,
    compact,
    contentGap: formDense ? gap + 4 : gap,
    contentPaddingHorizontal: padding,
    contentPaddingVertical: compact ? 12 : 16,
    emptyMinHeight: kind === 'list' ? (compact ? 156 : 176) : compact ? 132 : 152,
    emptyPadding: padding,
    inlineActionMinHeight: compact ? 38 : 42,
    inlineActionMinWidth: compact ? 74 : 88,
    listPaddingHorizontal: padding,
    listPaddingVertical: compact ? 8 : 12,
    listSeparatorInset: compact ? 20 : 24,
    metricGap: compact ? 6 : 8,
    metricMinHeight: formDense ? (compact ? 58 : 62) : compact ? 36 : 38,
    metricMinWidth: compact ? 88 : 96,
    stackInlineRows,
    summaryGap: gap,
    toolbarGap: gap,
    toolbarMinHeight: compact ? 52 : 56,
    toolbarPaddingHorizontal: padding,
    toolbarPaddingVertical: compact ? 8 : 12,
  };
}

function normalizeCount(value: number | undefined): number {
  if (!Number.isFinite(value) || !value || value <= 0) return 0;
  return Math.floor(value);
}

function normalizeDimension(value: number, fallback: number): number {
  return Number.isFinite(value) && value > 0 ? value : fallback;
}
