import { useEffect } from 'react';

/**
 * 页面级 safe-area padding 解析(top/left/right 三边;bottom 由各页按需自行兜底)。
 *
 * 为什么不用 react-native-safe-area-context 的原生 SafeAreaView:它的 Fabric 实现
 * 依赖「provider 通知 + didMoveToWindow」被动刷新,旋转若落在页面 detach / 视图回收
 * 的窗口期会漏更新,横屏 insets(top=0、左右 ~59pt)残留到竖屏,直到下一次无关的
 * React 提交才自愈(表现为首页竖屏后错位几秒)。这里改为消费 useSafeAreaInsets():
 * 数据源是根 provider 的布局事件,根 provider 永远挂在 window 上,旋转必触发。
 *
 * 另加一道确定性保险,但只精确狙击「横屏残留」形态,不误伤合法数据:
 * - insets 来自同一 provider 事件的原子快照,横屏残留必然是完整横屏形态——
 *   top ≤ 0 且至少一侧 > 0(刘海机横屏 top 恒为 0、侧边为刘海/挖孔让位);
 * - 合法的竖屏侧边 inset(Android 瀑布屏 / 侧边挖孔 / 折叠屏等)必然伴随
 *   非零的状态栏 top,不会命中上述形态,原样透传(与原生 SafeAreaView 行为一致);
 * - 命中残留形态时侧边清零,top 用「最近一次稳定竖屏 top」兜底,避免尺寸先于
 *   insets 更新的过渡帧里标题顶进状态栏。
 * 横屏值一律原样透传,不做假设。
 *
 * top 兜底记忆是模块级而非组件实例级:页面被路由 detach 后重挂时(典型路径
 * 「会话页横屏 → 返回首页 → 转竖屏」),实例级 ref 会归零导致首帧兜底失效;
 * 竖屏状态栏高度是设备级属性,进程内跨实例复用是安全的。冷启动首帧记忆为 0,
 * 但冷启动 insets 必然新鲜、不会命中残留形态,不受影响。
 */

export interface ScreenEdgeInsetsInput {
  /** 残留形态下 top 的兜底值(最近一次稳定竖屏 top);不传则残留帧 top 为 0。 */
  fallbackPortraitTop?: number;
  insets: { top: number; left: number; right: number };
  windowHeight: number;
  windowWidth: number;
}

export interface ScreenEdgePadding {
  paddingLeft: number;
  paddingRight: number;
  paddingTop: number;
}

/** 模块级「最近一次稳定竖屏 top」记忆,跨页面实例存活(见文件头注释)。 */
let stablePortraitTopMemory = 0;

export function resolveScreenEdgePadding(input: ScreenEdgeInsetsInput): ScreenEdgePadding {
  const top = sanitize(input.insets.top);
  const left = sanitize(input.insets.left);
  const right = sanitize(input.insets.right);
  const portrait = input.windowHeight > input.windowWidth;
  const landscapeResidue = portrait && top <= 0 && (left > 0 || right > 0);
  if (landscapeResidue) {
    return {
      paddingLeft: 0,
      paddingRight: 0,
      paddingTop: sanitize(input.fallbackPortraitTop ?? 0),
    };
  }
  return { paddingLeft: left, paddingRight: right, paddingTop: top };
}

/** 竖屏且 top 有效时记入模块级记忆;横屏与残留形态(top=0)天然不满足条件,不会污染。 */
export function recordStablePortraitTop(input: {
  top: number;
  windowHeight: number;
  windowWidth: number;
}): void {
  if (input.windowHeight > input.windowWidth && Number.isFinite(input.top) && input.top > 0) {
    stablePortraitTopMemory = input.top;
  }
}

export function getStablePortraitTopMemory(): number {
  return stablePortraitTopMemory;
}

export function resetStablePortraitTopMemoryForTests(): void {
  stablePortraitTopMemory = 0;
}

/**
 * 页面容器三边 padding hook:commit 后记录稳定竖屏 top(残留过渡帧读到的必然是
 * 此前正常帧或上一个页面实例记入的值),渲染期解析当前 insets。
 */
export function useScreenEdgePadding(input: {
  insets: { top: number; left: number; right: number };
  windowHeight: number;
  windowWidth: number;
}): ScreenEdgePadding {
  const { insets, windowHeight, windowWidth } = input;
  useEffect(() => {
    recordStablePortraitTop({ top: insets.top, windowHeight, windowWidth });
  }, [insets.top, windowHeight, windowWidth]);
  return resolveScreenEdgePadding({
    fallbackPortraitTop: getStablePortraitTopMemory(),
    insets,
    windowHeight,
    windowWidth,
  });
}

function sanitize(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0;
}
