import { useMemo } from "react";

import { cn } from "@/components/lib/utils.js";
import { useGlobalTaskList } from "@/hooks/useGlobalTaskList.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { getPathLeaf } from "@/lib/path.js";
import { formatTaskRelativeTime } from "@/lib/taskListItemPresentation.js";

import { useLeoHome, type LeoHomeContextValue } from "./LeoHomeContext.js";
import { classifyLeoStatusRows } from "./leoStatusRows.js";

/**
 * [leo] 首页(新任务草稿页)输入框下方的「进行中」清单:先列等你确认 / 回答的,再列在跑的,
 * 最后是跑完还没看的。最多 4 行,什么都没有就不出现 —— 首页平时只有问候和输入框。
 */
const MAX_ROWS = 4;
/** 只看最近更新的这些任务;更早的「待看」不值得挤上首页。 */
const SCAN_LIMIT = 40;

export function LeoDraftStatusList({ className }: { className?: string }) {
  const home = useLeoHome();
  if (!home || home.workspaceTabs.length === 0) return null;
  return <LeoDraftStatusListBody home={home} className={className} />;
}

function LeoDraftStatusListBody({
  home,
  className,
}: {
  home: LeoHomeContextValue;
  className?: string;
}) {
  const { intl } = useZCodeIntl();
  const { items } = useGlobalTaskList({
    kind: "active",
    workspaceTabs: home.workspaceTabs,
    sortBy: "updated",
    searchQuery: "",
    expanded: false,
    collapsedLimit: SCAN_LIMIT,
  });
  const rows = useMemo(() => classifyLeoStatusRows(items), [items]);
  if (rows.length === 0) return null;

  const visible = rows.slice(0, MAX_ROWS);
  const hidden = rows.length - visible.length;
  const showProject = home.workspaceTabs.length > 1;

  return (
    <section
      aria-label="进行中的任务"
      className={cn("leo-home-status w-full max-w-2xl px-1", className)}
    >
      <div className="mb-1.5 flex items-baseline justify-between px-3">
        <span className="text-ui-caption text-foreground-subtlest">进行中</span>
        {hidden > 0 ? (
          <span className="text-ui-caption text-foreground-subtlest">另有 {hidden} 个在侧栏</span>
        ) : null}
      </div>
      <ul className="flex flex-col">
        {visible.map(({ task, state, label }) => {
          const title =
            task.title?.trim() || intl.formatMessage({ id: "taskList.untitled" });
          const project = showProject ? getPathLeaf(task.workspacePath) : "";
          return (
            <li key={`${task.workspaceIdentity?.trim() || task.workspacePath}:${task.taskId}`}>
              <button
                type="button"
                data-leo-status-row={state}
                onClick={() =>
                  home.onSelectTask(
                    task.workspacePath,
                    task.taskId,
                    task.workspaceIdentity,
                    task.unreadAt,
                  )
                }
                className="group flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left transition-colors duration-150 hover:bg-hover"
              >
                <span
                  aria-hidden="true"
                  data-state={state}
                  className="leo-status-dot size-1.5 shrink-0 rounded-full"
                />
                <span className="min-w-0 flex-1 truncate text-ui-base text-foreground">
                  {title}
                  {project ? (
                    <span className="ml-2 text-ui-caption text-foreground-subtlest">{project}</span>
                  ) : null}
                </span>
                <span
                  className={cn(
                    "shrink-0 text-ui-caption",
                    state === "attention" ? "text-[var(--leo-attention)]" : "text-foreground-subtle",
                  )}
                >
                  {label}
                </span>
                <span className="w-14 shrink-0 text-right text-ui-caption text-foreground-subtlest tabular-nums">
                  {formatTaskRelativeTime(task.updatedAt, intl)}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
