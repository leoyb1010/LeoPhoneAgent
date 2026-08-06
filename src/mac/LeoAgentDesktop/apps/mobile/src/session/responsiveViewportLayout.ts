export interface MobileReadableViewportLayoutInput {
  screenHeight?: number;
  screenWidth?: number;
}

export interface MobileReadableViewportLayout {
  contentMaxWidth: number;
  contentWidth: number;
  landscape: boolean;
  shortViewport: boolean;
  wideViewport: boolean;
}

const DEFAULT_SCREEN_WIDTH = 390;
const DEFAULT_SCREEN_HEIGHT = 812;
const SHORT_VIEWPORT_HEIGHT = 520;
const WIDE_VIEWPORT_WIDTH = 700;
const WIDE_VIEWPORT_SIDE_INSET = 48;
const MIN_WIDE_CONTENT_WIDTH = 520;
const MAX_READABLE_CONTENT_WIDTH = 760;

export function buildMobileReadableViewportLayout(
  input: MobileReadableViewportLayoutInput,
): MobileReadableViewportLayout {
  const screenWidth = normalizeDimension(input.screenWidth, DEFAULT_SCREEN_WIDTH);
  const screenHeight = normalizeDimension(input.screenHeight, DEFAULT_SCREEN_HEIGHT);
  const landscape = screenWidth > screenHeight;
  const shortViewport = screenHeight < SHORT_VIEWPORT_HEIGHT;
  const wideViewport = screenWidth >= WIDE_VIEWPORT_WIDTH || landscape;
  const contentMaxWidth = wideViewport
    ? Math.min(
      screenWidth,
      clamp(
        screenWidth - WIDE_VIEWPORT_SIDE_INSET * 2,
        MIN_WIDE_CONTENT_WIDTH,
        MAX_READABLE_CONTENT_WIDTH,
      ),
    )
    : screenWidth;
  const contentWidth = Math.min(screenWidth, contentMaxWidth);

  return {
    contentMaxWidth,
    contentWidth,
    landscape,
    shortViewport,
    wideViewport,
  };
}

function normalizeDimension(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && value !== undefined && value > 0 ? value : fallback;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
