import type { ReactNode } from "react";
import leoLogoUrl from "@/assets/leo-logo.svg";

interface RootStartupLoadingProps {
  label: string;
  children?: ReactNode;
  busy?: boolean;
}

export function RootStartupLoading({ label, children, busy = true }: RootStartupLoadingProps) {
  return (
    <div
      // Web 端全局 html/body/#root 为 Electron 透明背景让路，React 接管后会替换 HTML 启动壳。
      // 这里必须由阻塞态自身承接主题背景，否则远控链接会在 Root 恢复期间继续露出浏览器白底。
      className="flex h-full min-h-dvh flex-col items-center justify-center gap-6 bg-background text-foreground"
      role="status"
      aria-busy={busy}
      aria-label={label}
      data-testid="root-startup-loading"
    >
      <ZCodeStartupLogoBadge />
      {children}
    </div>
  );
}

/** 启动加载的品牌图标。 */
function ZCodeStartupLogoBadge() {
  // [leo] 启动加载用 LeoBot 机器人标志；1.9.0 起和 HTML 启动壳同尺寸、同圆角、不再呼吸，
  // React 接管前后是同一个静止的标志，启动过程不跳不闪。
  return (
    <img
      src={leoLogoUrl}
      alt=""
      aria-hidden="true"
      draggable={false}
      className="size-18 shrink-0 rounded-[22px] shadow-lg/20"
    />
  );
}
