import { cn } from "@/components/lib/utils.js";

/**
 * [leo] LeoBot 标志：与应用图标同一个机器人（B 形身体、面罩、笑眼、嘴、侧耳）。
 * 身体色走 --leo-mark-from，耳朵内侧走 --leo-mark-to；面罩与眼睛用固定的深蓝 / 米白。
 */
export function LeoMark({ className, title }: { className?: string; title?: string }) {
  return (
    <svg
      viewBox="285 300 675 655"
      className={cn("text-foreground", className)}
      role={title ? "img" : undefined}
      aria-hidden={title ? undefined : true}
      aria-label={title}
      xmlns="http://www.w3.org/2000/svg"
    >
      <path d="M345 475C345 370 420 312 530 312H760C870 312 940 400 940 500C940 570 905 620 860 645C915 670 948 725 948 790C948 880 880 942 790 942H520C420 942 345 880 345 790Z" style={{ fill: "var(--leo-mark-from, #9fb9d2)" }} />
      <rect x="330" y="475" width="95" height="187" rx="47" style={{ fill: "var(--leo-mark-to, #3a5a80)" }} />
      <rect x="298" y="475" width="75" height="187" rx="37" style={{ fill: "var(--leo-mark-from, #9fb9d2)" }} />
      <rect x="512" y="395" width="384" height="237" rx="105" fill="#1d3349" />
      <path
        d="M575 538Q617 482 659 538M760 538Q802 482 844 538"
        fill="none"
        stroke="#fbf6ea"
        strokeWidth="22"
        strokeLinecap="round"
      />
      <rect x="634" y="760" width="146" height="42" rx="21" fill="#1d3349" />
    </svg>
  );
}
