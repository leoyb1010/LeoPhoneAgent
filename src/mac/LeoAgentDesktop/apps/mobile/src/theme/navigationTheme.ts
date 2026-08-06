import type { Theme as NavigationTheme } from 'expo-router';
import type { ThemeColors } from './tokens';

/**
 * 把 Cindy 色板投影到 React Navigation 主题。
 *
 * Native Stack 的 iOS 交互式返回会在页面位移时露出 ScreenStack 容器；该容器读取
 * `theme.colors.background`，不读取页面自己的 `contentStyle`。因此导航主题必须和应用
 * light / dark 色板同步，避免深色页面侧滑时露出 React Navigation 的默认浅色底。
 */
export function createNavigationTheme(
  baseTheme: NavigationTheme,
  colors: ThemeColors,
): NavigationTheme {
  return {
    ...baseTheme,
    colors: {
      ...baseTheme.colors,
      primary: colors.inputCaret,
      background: colors.surface,
      card: colors.surface,
      text: colors.textPrimary,
      border: colors.border,
      notification: colors.statusError,
    },
  };
}
