import { Pause, Timer } from 'lucide-react-native';
import { StyleSheet, View } from 'react-native';

import { useTheme, useThemedStyles, type ThemeColors } from '@/theme';
import { iconSize, iconStroke, radius } from '@/theme/tokens';

// 暂停角标是图标内部的微几何，不进入布局占位。两档尺寸分别服务首页的
// 12px 紧凑行与 18px legacy 行，保持与桌面 Timer + Pause 角标相同的视觉比例。
const COMPACT_BADGE_SIZE = 8;
const COMPACT_PAUSE_SIZE = 5;
const REGULAR_BADGE_SIZE = 12;
const REGULAR_PAUSE_SIZE = 8;
const COMPACT_BADGE_OFFSET = -2;
const REGULAR_BADGE_OFFSET = -3;

export interface AutomationTimerIconProps {
  paused?: boolean;
  size?: number;
  testID?: string;
}

/**
 * 自动任务的统一视觉标识。
 *
 * 主图标始终使用 Timer；paused / expired 只在固定槽位右下叠 Pause 角标，
 * 不替换主图标、不改变 flex 占位，避免任务状态切换时尾部图标横向跳动。
 */
export function AutomationTimerIcon({
  paused = false,
  size = iconSize.xs,
  testID,
}: AutomationTimerIconProps) {
  const styles = useThemedStyles(makeStyles);
  const { colors } = useTheme();
  const compact = size <= iconSize.xs;
  const badgeSize = compact ? COMPACT_BADGE_SIZE : REGULAR_BADGE_SIZE;
  const pauseSize = compact ? COMPACT_PAUSE_SIZE : REGULAR_PAUSE_SIZE;
  const badgeOffset = compact ? COMPACT_BADGE_OFFSET : REGULAR_BADGE_OFFSET;

  return (
    <View
      pointerEvents="none"
      style={[styles.slot, { height: size, width: size }]}
      testID={testID}
    >
      <Timer color={colors.textTertiary} size={size} strokeWidth={iconStroke.thin} />
      {paused ? (
        <View
          style={[
            styles.pauseBadge,
            {
              bottom: badgeOffset,
              height: badgeSize,
              right: badgeOffset,
              width: badgeSize,
            },
          ]}
          testID={testID ? `${testID}.paused` : undefined}
        >
          <Pause color={colors.textTertiary} size={pauseSize} strokeWidth={iconStroke.bold} />
        </View>
      ) : null}
    </View>
  );
}

const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    slot: {
      alignItems: 'center',
      flexShrink: 0,
      justifyContent: 'center',
      overflow: 'visible',
      position: 'relative',
    },
    pauseBadge: {
      alignItems: 'center',
      backgroundColor: colors.surfaceChip,
      borderColor: colors.border,
      borderRadius: radius.pill,
      borderWidth: StyleSheet.hairlineWidth,
      justifyContent: 'center',
      position: 'absolute',
    },
  });
