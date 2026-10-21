import { useMemo } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";

import { Button } from "@/components/ui/button.js";
import { cn } from "@/components/lib/utils.js";
import { useGlobalTaskList } from "@/hooks/useGlobalTaskList.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { getPathLeaf } from "@/lib/path.js";
import { formatTaskRelativeTime } from "@/lib/taskListItemPresentation.js";

import { LeoAgentBadge } from "./LeoAgentBadge.js";
import { useLeoHome, type LeoHomeContextValue } from "./LeoHomeContext.js";
import { classifyLeoStatusRows } from "./leoStatusRows.js";
import { LEO_DURATION, LEO_EASE_OUT } from "./skin/leoTokens.generated.js";

/**
 * [leo] 首页(新任务草稿页)输入框下方的「进行中」清单:先列等你确认 / 回答的,再列失败待看的、在跑的,
 * 最后是其余结束但还没看的。最多 4 行,什么都没有就不出现 —— 首页平时只有问候和输入框。
 */
const MAX_ROWS = 4;
/** 只看最近更新的这些任务;更早的「待看」不值得挤上首页。 */
const SCAN_LIMIT = 40;

/**
 * [wp-31] 首页三段式(最近工作区卡 / 输入框 / 状态行)共用同一份任务列表查询:参数完全相同,
 * Controller 列表注册表按 queryKey 合并,两处调用不会多打一次 Host。
 */
export function useLeoHomeTasks(home: LeoHomeContextValue) {
  return useGlobalTaskList({
    kind: "active",
    workspaceTabs: home.workspaceTabs,
    sortBy: "updated",
    searchQuery: "",
    expanded: false,
    collapsedLimit: SCAN_LIMIT,
  });
}

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
  const reducedMotion = useReducedMotion();
  const { items, loading, loadError, refresh } = useLeoHomeTasks(home);
  const rows = useMemo(() => classifyLeoStatusRows(items), [items]);
  if (rows.length === 0 && !loading && !loadError) return null;

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
      {loading || loadError ? (
        <div className="mb-2 flex flex-wrap items-center gap-2 rounded-lg bg-surface px-3 py-2" data-testid="home-task-list-load-state">
          <p role={loadError ? "alert" : "status"} className="min-w-0 flex-1 text-ui-caption text-foreground-subtle">
            {intl.formatMessage({ id: loadError ? "leoHome.tasksLoadFailed" : "leoHome.tasksLoading" })}
            {loadError && items.length > 0 ? ` ${intl.formatMessage({ id: "leoHome.tasksLastResults" })}` : ""}
          </p>
          {loadError ? (
            <Button type="button" variant="outline" size="sm" onClick={() => void refresh()}>
              {intl.formatMessage({ id: "leoHome.tasksRetry" })}
            </Button>
          ) : null}
        </div>
      ) : null}
      <ul className="flex flex-col">
        {/* [wp-31] 状态行进出:motion layout + AnimatePresence,dur.2 / ease.out;减弱动态下只淡入淡出。 */}
        <AnimatePresence initial={false}>
        {visible.map(({ task, state, label, agentKind }) => {
          const title =
            task.title?.trim() || intl.formatMessage({ id: "taskList.untitled" });
          const project = showProject ? getPathLeaf(task.workspacePath) : "";
          return (
            <motion.li
              key={`${task.workspaceIdentity?.trim() || task.workspacePath}:${task.taskId}`}
              layout={reducedMotion ? false : "position"}
              initial={reducedMotion ? { opacity: 0 } : { opacity: 0, y: 4 }}
              animate={reducedMotion ? { opacity: 1 } : { opacity: 1, y: 0 }}
              exit={{ opacity: 0 }}
              transition={{
                duration: reducedMotion ? LEO_DURATION.d1 : LEO_DURATION.d2,
                ease: LEO_EASE_OUT,
              }}
            >
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
                className="group flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left transition-colors duration-[var(--leo-dur-1)] hover:bg-hover focus-visible:bg-hover focus-visible:outline-2! focus-visible:-outline-offset-2! focus-visible:outline-brand!"
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
                <LeoAgentBadge kind={agentKind} />
                <span
                  className={cn(
                    "shrink-0 text-ui-caption",
                    state === "attention" ? "text-[var(--leo-attention)]" : state === "error" ? "text-destructive" : "text-foreground-subtle",
                  )}
                >
                  {label}
                </span>
                <span className="w-14 shrink-0 text-right text-ui-caption text-foreground-subtlest tabular-nums">
                  {formatTaskRelativeTime(task.updatedAt, intl)}
                </span>
              </button>
            </motion.li>
          );
        })}
        </AnimatePresence>
      </ul>
    </section>
  );
}
