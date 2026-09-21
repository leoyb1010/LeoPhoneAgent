import type { ReactNode } from "react";
import leoLogoUrl from "@/assets/leo-logo.svg";
import { cn } from "@/components/lib/utils.js";

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

/** 初始化与引导共用品牌图标，保持底色、描边、圆角和标志比例一致。 */
export function ZCodeStartupLogoBadge({ animated = true }: { animated?: boolean }) {
  // [leo] 启动加载与引导页的品牌标志换成 LeoPhoneAgent 图标;动效保留为轻微呼吸。
  return (
    <img
      src={leoLogoUrl}
      alt=""
      aria-hidden="true"
      draggable={false}
      className={cn("size-24 shrink-0 rounded-3xl shadow-xl/20", animated && "motion-safe:animate-pulse")}
    />
  );
}
