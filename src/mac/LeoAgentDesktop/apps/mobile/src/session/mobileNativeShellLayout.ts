import { buildMobileReadableViewportLayout } from '@/session/responsiveViewportLayout';

export type MobileNativePlatform = 'ios' | 'android' | 'web' | 'native';

export interface MobileKeyboardLayoutInput {
  keyboardHeight: number;
  keyboardVisible: boolean;
  platform: MobileNativePlatform;
  safeAreaBottomInset?: number;
  screenHeight: number;
  screenWidth?: number;
}

export interface SessionNativeShellLayoutInput extends MobileKeyboardLayoutInput {
  attachmentPickerOpen: boolean;
  paletteOpen: boolean;
}

export interface SessionNativeShellLayout {
  contentMaxWidth: number;
  contentWidth: number;
  composerMaxHeight: number;
  composerScrollEnabled: boolean;
  keyboardAvoidingBehavior: 'height' | 'padding' | undefined;
  keyboardBottomInset: number;
  keyboardVerticalOffset: number;
  landscape: boolean;
  paletteMaxHeight: number;
  pendingSurfaceExpandedHeight: number;
  pendingSurfaceMaxHeight: number;
  sheetMaxHeight: number;
  wideViewport: boolean;
}

const DEFAULT_SCREEN_HEIGHT = 812;
const MIN_KEYBOARD_VISIBLE_HEIGHT = 80;

export function buildSessionNativeShellLayout(
  input: SessionNativeShellLayoutInput,
): SessionNativeShellLayout {
  const screenHeight = normalizeDimension(input.screenHeight, DEFAULT_SCREEN_HEIGHT);
  const viewportLayout = buildMobileReadableViewportLayout({
    screenHeight,
    screenWidth: input.screenWidth,
  });
  const { contentMaxWidth, contentWidth, landscape, shortViewport, wideViewport } = viewportLayout;
  const keyboardHeight = input.keyboardVisible
    ? Math.min(normalizeDimension(input.keyboardHeight, 0), Math.round(screenHeight * 0.62))
    : 0;
  const keyboardVisible = input.keyboardVisible && keyboardHeight >= MIN_KEYBOARD_VISIBLE_HEIGHT;
  const safeAreaBottomInset = normalizeDimension(input.safeAreaBottomInset, 0);
  const keyboardBottomInset = input.platform === 'ios' && keyboardVisible
    ? Math.max(0, keyboardHeight - safeAreaBottomInset)
    : 0;
  const availableHeight = Math.max(320, screenHeight - keyboardHeight);
  const compactByKeyboard = keyboardVisible && availableHeight < screenHeight * 0.72;
  const composerRatio = compactByKeyboard
    ? 0.42
    : input.attachmentPickerOpen
      ? shortViewport ? 0.5 : 0.46
      : shortViewport ? 0.3 : 0.36;
  const dynamicHeight = compactByKeyboard ? availableHeight : screenHeight;
  const composerMinHeight = compactByKeyboard
    ? shortViewport ? 112 : 156
    : shortViewport ? 118 : 196;
  const composerMaxLimit = compactByKeyboard
    ? shortViewport ? 188 : 264
    : shortViewport ? 184 : 360;
  const composerMaxHeight = clamp(
    Math.round(dynamicHeight * composerRatio),
    composerMinHeight,
    composerMaxLimit,
  );
  const sheetMaxHeight = clamp(
    Math.round(dynamicHeight * (compactByKeyboard ? 0.74 : 0.88)),
    compactByKeyboard ? shortViewport ? 220 : 280 : shortViewport ? 240 : 360,
    Math.round(screenHeight * (shortViewport ? 0.84 : 0.88)),
  );
  // 键盘收起时允许待处理卡片按内容自然长高到 sheet 上限，避免 ask-user
  // 的底部操作被屏幕裁掉；键盘弹出后仍收紧高度并通过内部滚动访问内容。
  const pendingContentMaxHeight = compactByKeyboard
    ? clamp(
      Math.round(dynamicHeight * 0.54),
      shortViewport ? 160 : 210,
      Math.round(screenHeight * (shortViewport ? 0.68 : 0.72)),
    )
    : sheetMaxHeight;
  // pending surface 延伸到屏幕底部，safe area padding 位于 surface 内部。
  // 总高度需额外包含 inset，才能维持迁移前相同的内容可用高度。
  const pendingSurfaceMaxHeight = pendingContentMaxHeight + safeAreaBottomInset;
  const pendingSurfaceExpandedHeight = sheetMaxHeight + safeAreaBottomInset;
  const paletteMaxHeight = clamp(
    Math.round(dynamicHeight * (compactByKeyboard ? 0.28 : 0.32)),
    compactByKeyboard ? shortViewport ? 96 : 112 : shortViewport ? 118 : 160,
    shortViewport ? 180 : 260,
  );

  return {
    contentMaxWidth,
    contentWidth,
    composerMaxHeight,
    composerScrollEnabled: keyboardVisible || input.attachmentPickerOpen || input.paletteOpen,
    keyboardAvoidingBehavior: keyboardAvoidingBehaviorForPlatform(input.platform),
    keyboardBottomInset,
    keyboardVerticalOffset: 0,
    landscape,
    paletteMaxHeight,
    pendingSurfaceExpandedHeight,
    pendingSurfaceMaxHeight,
    sheetMaxHeight,
    wideViewport,
  };
}

export function keyboardAvoidingBehaviorForPlatform(
  platform: MobileNativePlatform,
): 'height' | 'padding' | undefined {
  if (platform === 'ios') return 'padding';
  if (platform === 'android' || platform === 'native') return 'height';
  return undefined;
}

function normalizeDimension(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
