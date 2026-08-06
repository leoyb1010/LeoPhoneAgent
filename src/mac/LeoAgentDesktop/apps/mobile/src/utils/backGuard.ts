import type { useRouter } from 'expo-router';

type Router = ReturnType<typeof useRouter>;

/**
 * 有守卫的返回导航。
 * ---------------------------------------------------------------------------
 * 返回栈为空时(deep link 冷启动直接进内页、界面卡顿时连续点返回等)裸调
 * `router.back()` 会派发一个没人处理的 GO_BACK action:dev 构建弹红色报错
 * "The action 'GO_BACK' was not handled by any navigator",生产构建静默无操作,
 * 用户感知为"点返回没反应"。此处统一守卫:能返回就返回,否则 replace 到
 * fallback 路由,保证任何时刻点返回都有确定去向。
 */
export function goBackGuarded(router: Router, fallback: Parameters<Router['replace']>[0] = '/'): void {
  const canGoBack = (router as { canGoBack?: () => boolean }).canGoBack?.() === true;
  if (canGoBack) {
    router.back();
    return;
  }
  router.replace(fallback);
}
