export type PayloadBodyLayoutKind = 'text' | 'diff' | 'media' | 'mermaid' | 'file';

export interface PayloadBodyLayoutInput {
  kind: PayloadBodyLayoutKind;
  screenWidth: number;
}

export interface PayloadBodyLayout {
  actionButtonMinHeight: number;
  actionButtonMinWidth: number;
  actionGap: number;
  bodyPadding: number;
  compact: boolean;
  diffContentGap: number;
  diffLineMinHeight: number;
  diffLineNumberWidth: number;
  diffLinePrefixWidth: number;
  diffPaneGap: number;
  diffPaneWidth: number;
  filePreviewMaxHeight: number;
  mediaFrameMinHeight: number;
  mediaPlayerMinHeight: number;
  mediaPlaceholderMinHeight: number;
  textScrollMaxHeight: number;
}

const DEFAULT_SCREEN_WIDTH = 390;
const COMPACT_WIDTH = 360;
const LARGE_WIDTH = 600;
const COMPACT_PADDING = 12;
const STANDARD_PADDING = 16;
const LARGE_PADDING = 24;
const COMPACT_GAP = 8;
const STANDARD_GAP = 12;
const LARGE_GAP = 16;

export function buildPayloadBodyLayout(input: PayloadBodyLayoutInput): PayloadBodyLayout {
  const screenWidth = normalizeDimension(input.screenWidth, DEFAULT_SCREEN_WIDTH);
  const compact = screenWidth <= COMPACT_WIDTH;
  const large = screenWidth >= LARGE_WIDTH;
  const bodyPadding = large ? LARGE_PADDING : compact ? COMPACT_PADDING : STANDARD_PADDING;
  const contentWidth = Math.max(0, screenWidth - bodyPadding * 2);
  const diffPaneGap = large ? LARGE_GAP : compact ? COMPACT_GAP : STANDARD_GAP;
  const diffPaneWidth = buildDiffPaneWidth({
    compact,
    contentWidth,
    diffPaneGap,
    large,
    screenWidth,
  });
  const mediaDetailScrollMaxHeight = compact ? 168 : large ? 260 : 192;
  // mermaid 不再消费本布局的源码区高度(详情走沉浸式全屏查看器,无源码区)。
  const textScrollMaxHeight = input.kind === 'media'
    ? mediaDetailScrollMaxHeight
    : compact
      ? 184
      : large
        ? 320
        : 220;
  return {
    actionButtonMinHeight: 40,
    actionButtonMinWidth: compact ? 92 : 104,
    actionGap: compact ? COMPACT_GAP : STANDARD_GAP,
    bodyPadding,
    compact,
    diffContentGap: compact ? COMPACT_GAP : STANDARD_GAP,
    diffLineMinHeight: compact ? 22 : 24,
    diffLineNumberWidth: compact ? 30 : 34,
    diffLinePrefixWidth: compact ? 12 : 14,
    diffPaneGap,
    diffPaneWidth,
    filePreviewMaxHeight: compact ? 184 : large ? 300 : 220,
    mediaFrameMinHeight: compact ? 260 : large ? 360 : 300,
    mediaPlayerMinHeight: compact ? 220 : large ? 320 : 260,
    mediaPlaceholderMinHeight: compact ? 220 : large ? 320 : 260,
    textScrollMaxHeight,
  };
}

function buildDiffPaneWidth({
  compact,
  contentWidth,
  diffPaneGap,
  large,
  screenWidth,
}: {
  compact: boolean;
  contentWidth: number;
  diffPaneGap: number;
  large: boolean;
  screenWidth: number;
}): number {
  if (large && contentWidth >= 680) {
    return Math.floor((contentWidth - diffPaneGap) / 2);
  }

  const minimum = compact ? 276 : 300;
  const maximum = compact ? 300 : 340;
  const comfortable = screenWidth - (compact ? 44 : 64);
  return Math.max(minimum, Math.min(maximum, comfortable));
}

function normalizeDimension(value: number, fallback: number): number {
  return Number.isFinite(value) && value > 0 ? value : fallback;
}
