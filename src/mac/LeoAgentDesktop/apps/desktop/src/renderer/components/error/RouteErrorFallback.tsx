/**
 * RouteErrorFallback — 路由级渲染崩溃兜底页(react-router errorElement)。
 *
 * 背景(2026-07-09 事故):release 端某组件在特定数据下渲染出 <undefined/>
 * (React #130),而路由树没有任何 errorElement,用户看到的是 react-router
 * 自带的开发者默认错误页("Hey developer 👋"),且整个应用锁死无法恢复。
 * 本组件保证:任何路由子树渲染崩溃时,用户看到的是符合产品视觉的可恢复页面。
 *
 * 两个挂载位置(见 router.tsx):
 *   - variant='fullscreen':挂在根路由('/'、'/login'),MainLayout 自身崩溃时全屏兜底。
 *   - variant='section'  :挂在 MainLayout children 的 pathless wrapper 上,
 *     内容区崩溃时保住外层导航 chrome,错误页只占内容区。
 *
 * RouterProvider **之上**的 provider 链崩溃由 TopLevelErrorBoundary 兜底(index.tsx),
 * 两者共用 AppCrashScreen 展示层。
 *
 * 崩溃详情通过统一 logger 上报进 main-*.log(此前 renderer 渲染崩溃在
 * release 日志里完全无痕,只能靠用户截图定位)。
 */

import { useEffect, useMemo } from 'react';
import { isRouteErrorResponse, useRouteError } from 'react-router-dom';

import { createLogger } from '@/lib/logger';
import { AppCrashScreen } from './AppCrashScreen';

const log = createLogger('route-error-fallback');

interface NormalizedError {
  message: string;
  stack?: string;
}

function normalizeRouteError(error: unknown): NormalizedError {
  if (isRouteErrorResponse(error)) {
    return { message: `${error.status} ${error.statusText}` };
  }
  if (error instanceof Error) {
    return { message: error.message, stack: error.stack };
  }
  return { message: String(error) };
}

export function RouteErrorFallback({
  variant = 'fullscreen',
}: {
  variant?: 'fullscreen' | 'section';
}) {
  const error = useRouteError();
  const { message, stack } = useMemo(() => normalizeRouteError(error), [error]);

  useEffect(() => {
    log.error('route render crashed', { variant, message, stack });
  }, [variant, message, stack]);

  return <AppCrashScreen variant={variant} message={message} stack={stack} />;
}
