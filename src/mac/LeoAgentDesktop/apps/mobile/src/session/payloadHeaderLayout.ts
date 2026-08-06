export interface PayloadHeaderLayoutInput {
  canCopy: boolean;
  canOpen: boolean;
  canPageGallery: boolean;
  screenWidth: number;
  screenHeight: number;
}

export interface PayloadModalSafeAreaInput {
  androidStatusBarHeight?: number;
  /** 横屏时 iOS 状态栏隐藏、刘海在侧边,顶部 fallback 收紧,不浪费纵向空间。 */
  landscape?: boolean;
  platform: string;
  safeAreaBottom: number;
  safeAreaTop: number;
}

export interface PayloadHeaderLayout {
  actionButtonMinWidth: number;
  actionGap: number;
  actionsAlignItems: 'center' | 'flex-end' | 'flex-start';
  /** 竖屏 actions 竖排(copy 行在上、关闭在下);横屏收成单行。 */
  actionsDirection: 'row' | 'column';
  actionsWidth: 'auto' | '100%';
  closeButtonMinWidth: number;
  compact: boolean;
  galleryButtonMinWidth: number;
  headerDirection: 'row' | 'column';
  headerGap: number;
  /** header 最小高度:横屏压成紧凑单行,纵向空间全部让给 body。 */
  headerMinHeight: number;
  headerPaddingHorizontal: number;
  landscape: boolean;
  primaryActionsJustifyContent: 'flex-end' | 'flex-start';
  /** 横屏隐藏副标题(信息常与标题重复,纵向空间优先给内容)。 */
  showSubtitle: boolean;
  titleNumberOfLines: number;
}

export interface PayloadModalSafeArea {
  paddingBottom: number;
  paddingTop: number;
}

const DEFAULT_SCREEN_WIDTH = 390;
const DEFAULT_SCREEN_HEIGHT = 844;
const COMPACT_WIDTH = 300;
const MIN_TITLE_WIDTH = 176;
const STANDARD_HORIZONTAL_PADDING = 16;
const COMPACT_HORIZONTAL_PADDING = 12;
const HEADER_GAP = 12;
const ACTION_GAP = 4;
const ACTION_BUTTON_MIN_WIDTH = 36;
const CLOSE_BUTTON_MIN_WIDTH = 40;
const GALLERY_BUTTON_MIN_WIDTH = 36;
const STANDARD_HEADER_MIN_HEIGHT = 72;
const LANDSCAPE_HEADER_MIN_HEIGHT = 48;
const IOS_MODAL_TOP_FALLBACK = 56;
const IOS_MODAL_BOTTOM_FALLBACK = 24;
const IOS_MODAL_LANDSCAPE_TOP_FALLBACK = 12;
const IOS_MODAL_LANDSCAPE_BOTTOM_FALLBACK = 12;

export function buildPayloadHeaderLayout(input: PayloadHeaderLayoutInput): PayloadHeaderLayout {
  const screenWidth = normalizeDimension(input.screenWidth, DEFAULT_SCREEN_WIDTH);
  const screenHeight = normalizeDimension(input.screenHeight, DEFAULT_SCREEN_HEIGHT);
  const landscape = screenWidth > screenHeight;
  const primaryActionCount = Number(input.canCopy) + Number(input.canOpen);
  const primaryActionsWidth = rowWidth(primaryActionCount, ACTION_BUTTON_MIN_WIDTH, ACTION_GAP);
  const galleryActionsWidth = input.canPageGallery
    ? rowWidth(2, GALLERY_BUTTON_MIN_WIDTH, ACTION_GAP)
    : 0;
  const actionColumnWidth = Math.max(primaryActionsWidth, galleryActionsWidth, CLOSE_BUTTON_MIN_WIDTH);
  const standardTextWidth = screenWidth
    - STANDARD_HORIZONTAL_PADDING * 2
    - HEADER_GAP
    - actionColumnWidth;
  const compact = !landscape && (screenWidth <= COMPACT_WIDTH || standardTextWidth < MIN_TITLE_WIDTH);

  return {
    actionButtonMinWidth: ACTION_BUTTON_MIN_WIDTH,
    actionGap: ACTION_GAP,
    actionsAlignItems: landscape ? 'center' : compact ? 'flex-start' : 'flex-end',
    actionsDirection: landscape ? 'row' : 'column',
    actionsWidth: compact ? '100%' : 'auto',
    closeButtonMinWidth: CLOSE_BUTTON_MIN_WIDTH,
    compact,
    galleryButtonMinWidth: GALLERY_BUTTON_MIN_WIDTH,
    headerDirection: compact ? 'column' : 'row',
    headerGap: compact ? ACTION_GAP : HEADER_GAP,
    headerMinHeight: landscape ? LANDSCAPE_HEADER_MIN_HEIGHT : STANDARD_HEADER_MIN_HEIGHT,
    headerPaddingHorizontal: compact ? COMPACT_HORIZONTAL_PADDING : STANDARD_HORIZONTAL_PADDING,
    landscape,
    primaryActionsJustifyContent: compact ? 'flex-start' : 'flex-end',
    showSubtitle: !landscape,
    titleNumberOfLines: landscape ? 1 : 2,
  };
}

export function buildPayloadModalSafeArea(input: PayloadModalSafeAreaInput): PayloadModalSafeArea {
  const top = normalizeNonNegative(input.safeAreaTop);
  const bottom = normalizeNonNegative(input.safeAreaBottom);
  const androidStatusBarHeight = normalizeNonNegative(input.androidStatusBarHeight ?? 0);
  const iosTopFallback = input.landscape ? IOS_MODAL_LANDSCAPE_TOP_FALLBACK : IOS_MODAL_TOP_FALLBACK;
  const iosBottomFallback = input.landscape
    ? IOS_MODAL_LANDSCAPE_BOTTOM_FALLBACK
    : IOS_MODAL_BOTTOM_FALLBACK;

  return {
    paddingBottom: Math.max(bottom, input.platform === 'ios' ? iosBottomFallback : 0),
    paddingTop: Math.max(
      top,
      input.platform === 'ios' ? iosTopFallback : 0,
      input.platform === 'android' ? androidStatusBarHeight : 0,
    ),
  };
}

function rowWidth(count: number, itemWidth: number, gap: number): number {
  if (count <= 0) return 0;
  return count * itemWidth + Math.max(count - 1, 0) * gap;
}

function normalizeDimension(value: number, fallback: number): number {
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function normalizeNonNegative(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0;
}
