import type { ReactNode } from "react";

import { cn } from "@/components/lib/utils.js";

import type { TerminalSessionDescriptor } from "./terminalPanelState.js";
import { useTerminalSplitDivider } from "./useTerminalSplitDivider.js";

/**
 * [leo] WP-24 终端面板的会话区:不分屏时只显示主终端;分屏时主终端在左、splitSession 在右,中间可拖的分隔条。
 *
 * 不用 react-resizable-panels 换布局:那样会重挂 TerminalSession,而它卸载就会结束 PTY。
 * 这里所有终端始终挂在同一层,只改 order / 宽度 / 显隐。
 */
export function TerminalSplitLayout({
  sessions,
  primaryId,
  secondaryId,
  workspaceKey,
  renderSession,
}: {
  sessions: TerminalSessionDescriptor[];
  primaryId: string | null;
  secondaryId: string | null;
  workspaceKey: string;
  renderSession: (session: TerminalSessionDescriptor, shown: boolean) => ReactNode;
}) {
  const divider = useTerminalSplitDivider();
  return (
    <div ref={divider.containerRef} className="flex min-h-0 flex-1 overflow-hidden">
      {secondaryId ? (
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label="调整分屏宽度"
          onPointerDown={divider.onPointerDown}
          onDoubleClick={divider.reset}
          className="relative order-1 w-2 shrink-0 cursor-col-resize after:absolute after:inset-y-1 after:left-1/2 after:w-px after:-translate-x-1/2 after:bg-border after:transition-colors after:duration-100 hover:after:bg-foreground-subtlest"
        />
      ) : null}
      {sessions.map((session) => {
        const isSecondary = session.id === secondaryId;
        const shown =
          session.workspaceKey === workspaceKey && (session.id === primaryId || isSecondary);
        const share = secondaryId ? (isSecondary ? 1 - divider.ratio : divider.ratio) : 1;
        return (
          <div
            key={session.id}
            role="tabpanel"
            aria-hidden={!shown}
            data-state={shown ? "active" : "inactive"}
            className={cn(
              "h-full min-h-0 min-w-0",
              !shown && "hidden",
              isSecondary ? "order-2" : "order-0",
            )}
            style={shown ? { flex: `${share} 1 0%` } : undefined}
          >
            {renderSession(session, shown)}
          </div>
        );
      })}
    </div>
  );
}
