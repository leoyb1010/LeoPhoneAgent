import { useMemo } from "react";
import { FolderIcon } from "lucide-react";

import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { getPathLeaf } from "@/lib/path.js";
import { formatTaskRelativeTime } from "@/lib/taskListItemPresentation.js";

import { LeoAgentBadge } from "./LeoAgentBadge.js";
import { useLeoHomeTasks } from "./LeoDraftStatusList.js";
import { useLeoHome, type LeoHomeContextValue } from "./LeoHomeContext.js";
import { pickLeoRecentWorkspaces } from "./leoStatusRows.js";

/**
 * [leo][wp-31] 首页三段式的第一段:最近工作区横向卡(≤5 个)。每张卡是该工作区最近更新的任务,
 * 点一下直接打开继续。没有任何任务时不占位。
 */
export function LeoRecentWorkspaces({ className }: { className?: string }) {
  const home = useLeoHome();
  if (!home || home.workspaceTabs.length === 0) return null;
  return <LeoRecentWorkspacesBody home={home} className={className} />;
}

function LeoRecentWorkspacesBody({
  home,
  className,
}: {
  home: LeoHomeContextValue;
  className?: string;
}) {
  const { intl } = useZCodeIntl();
  const { items } = useLeoHomeTasks(home);
  const recent = useMemo(() => pickLeoRecentWorkspaces(items), [items]);
  if (recent.length === 0) return null;

  return (
    <section
      aria-label="最近工作区"
      data-testid="leo-home-recent"
      className={cn("leo-home-recent w-full max-w-2xl", className)}
    >
      <div className="mb-1.5 px-1 text-ui-caption text-foreground-subtlest">最近工作区</div>
      <ul className="flex gap-2 overflow-x-auto pb-1 [scrollbar-width:none]">
        {recent.map(({ key, workspacePath, workspaceIdentity, task, agentKind }) => {
          const title =
            task.title?.trim() || intl.formatMessage({ id: "taskList.untitled" });
          return (
            <li key={key} className="min-w-[8.5rem] max-w-56 flex-1 basis-0">
              <button
                type="button"
                data-leo-recent-workspace={key}
                title={`${getPathLeaf(workspacePath)} · ${title}`}
                onClick={() =>
                  home.onSelectTask(workspacePath, task.taskId, workspaceIdentity, task.unreadAt)
                }
                className="leo-recent-card flex h-full w-full flex-col gap-1 rounded-[var(--leo-radius-mac-card)] border border-border bg-card px-3 py-2.5 text-left hover:border-border-hover hover:bg-surface-hover focus-visible:outline-2! focus-visible:-outline-offset-2! focus-visible:outline-brand!"
              >
                <span className="flex min-w-0 items-center gap-1.5">
                  <FolderIcon aria-hidden="true" className="size-3.5 shrink-0 text-foreground-subtle" />
                  <span className="min-w-0 truncate text-ui-caption font-medium text-foreground">
                    {getPathLeaf(workspacePath)}
                  </span>
                </span>
                <span className="min-w-0 truncate text-ui-sm text-foreground-subtle">{title}</span>
                <span className="mt-auto flex items-center justify-between gap-1 pt-0.5">
                  <LeoAgentBadge kind={agentKind} />
                  <span className="text-ui-xs text-foreground-subtlest tabular-nums">
                    {formatTaskRelativeTime(task.updatedAt, intl)}
                  </span>
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
