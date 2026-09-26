import { useId } from "react";

import { cn } from "@/components/lib/utils.js";

/**
 * [leo] LeoPhoneAgent 标志:L + 播放箭头 + 圆点,与应用图标同一套几何。
 * 颜色走皮肤变量(--leo-mark-from / --leo-mark-to),深浅主题各自取值;箭头用 currentColor。
 */
export function LeoMark({ className, title }: { className?: string; title?: string }) {
  const gradientId = `leo-mark-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  return (
    <svg
      viewBox="296 296 470 432"
      className={cn("text-foreground", className)}
      role={title ? "img" : undefined}
      aria-hidden={title ? undefined : true}
      aria-label={title}
      xmlns="http://www.w3.org/2000/svg"
    >
      <defs>
        <linearGradient id={gradientId} x1="0" y1="0" x2="0.35" y2="1">
          <stop offset="0" style={{ stopColor: "var(--leo-mark-from, #a6f3d8)" }} />
          <stop offset="1" style={{ stopColor: "var(--leo-mark-to, #3eb4ae)" }} />
        </linearGradient>
      </defs>
      <path d="M314 314H436V612H650V710H314V314Z" fill={`url(#${gradientId})`} />
      <path d="M562 420L710 512L562 604V420Z" fill="currentColor" opacity={0.82} />
      <circle cx="710" cy="512" r="43" style={{ fill: "var(--leo-mark-to, #3eb4ae)" }} />
    </svg>
  );
}
