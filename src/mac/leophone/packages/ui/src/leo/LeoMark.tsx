import { cn } from "@/components/lib/utils.js";

/**
 * [leo] LOBE 标志：与应用图标同一个 L（主体 + 内侧浅蓝弧带）。
 * 颜色走皮肤变量（--leo-mark-from 主体 / --leo-mark-to 弧带），深浅主题各自取值。
 */
export function LeoMark({ className, title }: { className?: string; title?: string }) {
  return (
    <svg
      viewBox="340 230 610 795"
      className={cn("text-foreground", className)}
      role={title ? "img" : undefined}
      aria-hidden={title ? undefined : true}
      aria-label={title}
      xmlns="http://www.w3.org/2000/svg"
    >
      <path
        d="M418 252H541Q597 252 597 308V740Q597 800 657 800H870Q926 800 926 856V945Q926 1001 870 1001H550C446 1001 362 917 362 813V308Q362 252 418 252Z"
        style={{ fill: "var(--leo-mark-from, #1d3349)" }}
      />
      <path
        d="M415 628C450 730 540 795 650 800H870Q926 800 926 856V943H640C520 943 415 840 415 700Z"
        style={{ fill: "var(--leo-mark-to, #9fb9d2)" }}
      />
    </svg>
  );
}
