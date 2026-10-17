import { BotIcon } from "lucide-react";

import { cn } from "@/components/lib/utils.js";

import { leoAgentKindLabel, type LeoAgentKind } from "./leoAgentKind.js";

/** [leo][wp-31] agent 类型徽标:brand-soft 底 + lucide 图标,首页状态行与输入框工具条共用。 */
export function LeoAgentBadge({ kind, className }: { kind: LeoAgentKind; className?: string }) {
  const label = leoAgentKindLabel(kind);
  return (
    <span
      data-leo-agent-kind={kind}
      title={`由 ${label} 执行`}
      className={cn(
        "inline-flex shrink-0 items-center gap-1 rounded-full bg-[var(--leo-brand-soft)] px-1.5 py-0.5 text-ui-xs leading-none text-[var(--leo-brand)]",
        className,
      )}
    >
      <BotIcon aria-hidden="true" className="size-3" />
      {label}
    </span>
  );
}
