export interface MessageHierarchyLayoutInput {
  screenWidth?: number;
  summaryCount: number;
}

export interface MessageHierarchyLayout {
  compact: boolean;
  foldBodyPaddingBottom: number;
  foldBodyPaddingHorizontal: number;
  foldHeaderGap: number;
  foldHeaderMinHeight: number;
  foldHeaderPaddingHorizontal: number;
  foldHeaderPaddingVertical: number;
  railPaddingLeft: number;
  stackGap: number;
  stackSmallGap: number;
  todoMarkWidth: number;
  todoRowGap: number;
  todoRowMinHeight: number;
  todoSummaryInset: number;
}

const DEFAULT_SCREEN_WIDTH = 390;
const COMPACT_WIDTH = 360;
const DENSE_SUMMARY_COUNT = 3;

export function buildMessageHierarchyLayout(input: MessageHierarchyLayoutInput): MessageHierarchyLayout {
  const screenWidth = normalizeDimension(input.screenWidth, DEFAULT_SCREEN_WIDTH);
  const summaryCount = normalizeCount(input.summaryCount);
  const compact = screenWidth <= COMPACT_WIDTH
    || summaryCount > DENSE_SUMMARY_COUNT;
  const todoMarkWidth = compact ? 20 : 22;
  const todoRowGap = compact ? 6 : 8;

  return {
    compact,
    foldBodyPaddingBottom: compact ? 12 : 16,
    foldBodyPaddingHorizontal: compact ? 12 : 16,
    foldHeaderGap: compact ? 8 : 12,
    foldHeaderMinHeight: compact ? 42 : 46,
    foldHeaderPaddingHorizontal: compact ? 12 : 16,
    foldHeaderPaddingVertical: compact ? 8 : 10,
    railPaddingLeft: compact ? 10 : 12,
    stackGap: compact ? 8 : 12,
    stackSmallGap: compact ? 6 : 8,
    todoMarkWidth,
    todoRowGap,
    todoRowMinHeight: compact ? 40 : 44,
    todoSummaryInset: todoMarkWidth + todoRowGap,
  };
}

function normalizeCount(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.floor(value);
}

function normalizeDimension(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && typeof value === 'number' && value > 0 ? value : fallback;
}
