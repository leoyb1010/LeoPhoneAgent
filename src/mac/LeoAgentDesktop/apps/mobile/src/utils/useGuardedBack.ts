import { useCallback, useEffect, useRef } from 'react';
import { useNavigation, usePathname, useRouter } from 'expo-router';

import { goBackGuarded } from './backGuard';

type Router = ReturnType<typeof useRouter>;

/**
 * back 派发后校验"是否真的离开了当前路由"的延迟(ms)。GO_BACK 被静默吞掉时
 * 路由不变,到点强制 replace 兜底;真实 back 的路由状态变更远快于该窗口。
 */
export const BACK_VERIFY_DELAY_MS = 200;

/**
 * goBackGuarded 的自愈增强版(hook 形态,组件内使用;与 backGuard.ts 分文件是因为
 * 本文件需要 expo-router 的 value import,合在一起会让纯逻辑测试连坐解析 RN 入口)。
 * ---------------------------------------------------------------------------
 * goBackGuarded 依赖 `router.canGoBack()`,但它可能与真实导航栈不一致(dev reload
 * 恢复深路由、重复压栈残留等):canGoBack 返回 true、GO_BACK 派发后却没有任何
 * navigator 处理——dev 弹 "not handled" 报错,生产**静默无操作**,用户感知为
 * "点返回永远没反应",只能杀 App 重进(2026-07 会话页实锤)。
 * 此 hook 在 back 派发后 BACK_VERIFY_DELAY_MS 校验 pathname 是否真的变化,
 * 没变就强制 replace 到 fallback,保证返回键任何时刻都有确定去向。
 *
 * 有意语义:重复压栈残留(/x → /x)时 back 虽成功 pop 但 pathname 不变、老屏
 * 在转场动画期仍挂载,校验会把它也收敛到 fallback——"按 N 次返回"折叠为一跳,
 * 与自愈目标一致,不是 bug。注意 usePathname 不含 query params:本 hook 只应
 * 用于以路径段区分身份的路由,靠 query 区分的路由会被误判为"没走成"。
 *
 * fallback 需引用稳定(字符串字面量或 memo 后的对象),否则返回的回调每次渲染
 * 都换新引用,消费方的 useCallback/useMemo 会连锁失效。
 */
export function useGuardedBack(fallback: Parameters<Router['replace']>[0] = '/'): () => void {
  const router = useRouter();
  const navigation = useNavigation();
  const pathname = usePathname();
  const pathnameRef = useRef(pathname);
  pathnameRef.current = pathname;
  // 校验计时器挂 ref、卸载时清:back 成功 = 本屏被 pop 卸载(不会再渲染,pathnameRef
  // 停在旧值),若不取消,到点的校验会把成功返回误判为"没走成"再 replace 劫持一跳;
  // back 被吞 = 本屏仍挂载,计时器如期触发兜底。
  const verifyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (verifyTimerRef.current) clearTimeout(verifyTimerRef.current);
  }, []);
  return useCallback(() => {
    const before = pathnameRef.current;
    goBackGuarded(router, fallback);
    if (verifyTimerRef.current) clearTimeout(verifyTimerRef.current);
    verifyTimerRef.current = setTimeout(() => {
      verifyTimerRef.current = null;
      // 双重条件才判定「back 被吞」:路由没变 且 本屏仍持有焦点。成功的 back 在
      // dispatch 当刻即让本屏失焦(读已提交导航状态,不等转场动画)——低端机转场
      // 再慢、pathname 更新再晚,失焦本身就排除误判(review P2 加固);被吞时导航
      // 状态无变化、本屏保持焦点,兜底照常触发。
      if (pathnameRef.current === before && navigation.isFocused()) router.replace(fallback);
    }, BACK_VERIFY_DELAY_MS);
  }, [fallback, navigation, router]);
}
