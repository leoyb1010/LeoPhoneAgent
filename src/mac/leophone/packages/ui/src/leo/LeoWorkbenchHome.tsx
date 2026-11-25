import { useState, type ReactNode } from "react";
import { ChevronRight, Code2, FileSearch, History, SquareTerminal } from "lucide-react";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { formatTaskRelativeTime } from "@/lib/taskListItemPresentation.js";
import { useZCodeSessionStore } from "@/store/zcodeSessionStore.js";
import { LeoAgentBadge } from "./LeoAgentBadge.js";
import { resolveLeoAgentKind } from "./leoAgentKind.js";
import { useLeoHome, type LeoHomeContextValue } from "./LeoHomeContext.js";
import { useLeoHomeTasks } from "./LeoDraftStatusList.js";
import { LEO_WORKBENCH_STARTERS } from "./leoWorkbenchPrompts.js";

export function LeoContinueLast({ workspaceKey }: { workspaceKey: string }) {
  const home = useLeoHome();
  return home ? <ContinueLastTask home={home} workspaceKey={workspaceKey} /> : null;
}

function ContinueLastTask({ home, workspaceKey }: { home: LeoHomeContextValue; workspaceKey: string }) {
  const { intl, locale } = useZCodeIntl();
  const { items } = useLeoHomeTasks(home);
  const task = items.find((entry) => (entry.workspaceIdentity?.trim() || entry.workspacePath) === workspaceKey);
  if (!task) return null;
  const agentKind = resolveLeoAgentKind(task);
  return (
    <button
      type="button"
      data-testid="leo-continue-last"
      onClick={() => home.onSelectTask(task.workspacePath, task.taskId, task.workspaceIdentity, task.unreadAt)}
      className="group mt-3 flex w-full max-w-2xl items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-ui-caption text-foreground-subtle transition-colors duration-[var(--leo-dur-1)] hover:bg-hover active:scale-[var(--leo-press-scale)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand motion-reduce:transition-none motion-reduce:active:scale-100"
    >
      <History aria-hidden="true" className="size-4 shrink-0" />
      <span className="shrink-0">{locale.startsWith("zh") ? "继续上次" : "Continue last task"}</span>
      <span className="min-w-0 flex-1 truncate font-medium text-foreground">
        {task.title?.trim() || intl.formatMessage({ id: "taskList.untitled" })}
      </span>
      <LeoAgentBadge kind={agentKind} />
      <span className="shrink-0 text-ui-caption text-foreground-subtlest tabular-nums">
        {formatTaskRelativeTime(task.updatedAt, intl)}
      </span>
      <ChevronRight
        aria-hidden="true"
        className="size-3.5 shrink-0 text-foreground-subtlest transition-transform duration-[var(--leo-dur-1)] group-hover:translate-x-0.5 motion-reduce:transform-none"
      />
    </button>
  );
}

export function LeoWorkbenchStarters({
  workspacePath,
  workspaceIdentity,
  className,
}: {
  workspacePath: string;
  workspaceIdentity?: string;
  className?: string;
}) {
  const { locale } = useZCodeIntl();
  const zh = locale.startsWith("zh");
  const icons = [Code2, SquareTerminal, FileSearch];
  return (
    <section
      className={cn(
        "leo-workbench-starters flex w-full max-w-2xl flex-wrap gap-2",
        className,
      )}
      aria-label={zh ? "开始一项任务" : "Start a task"}
    >
      {LEO_WORKBENCH_STARTERS.map((starter, index) => {
        const Icon = icons[index]!;
        return (
          <button
            key={starter.id}
            type="button"
            data-testid={`leo-starter-${starter.id}`}
            onClick={() =>
              useZCodeSessionStore
                .getState()
                .requestComposerTextInsert(
                  workspacePath,
                  zh
                    ? starter.prompt
                    : starter.id === "html"
                      ? "Build and check a single-file HTML brief with no external resources. My topic is:"
                      : starter.id === "code"
                        ? "Read this project's rules and relevant code, preserve existing edits, implement my changes and run the relevant checks. My goal is:"
                        : "Research the supplied material, distinguish facts and inferences, retain sources and produce a clear report with suitable HTML, Markdown or structured data files. My topic is:",
                  workspaceIdentity,
                  undefined,
                  "append-if-missing",
                )
            }
            title={zh ? starter.description : starter.enDescription}
            className="group flex min-h-8 items-center gap-2 rounded-lg border border-border bg-background px-3 py-1.5 text-left transition-colors hover:border-border-hover hover:bg-surface focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand motion-reduce:transition-none"
          >
            <Icon aria-hidden="true" className="size-4 shrink-0 text-brand" />
            <span className="min-w-0 flex-1">
              <span className="block text-ui-caption font-medium text-foreground">
                {zh ? starter.title : starter.en}
              </span>
            </span>
          </button>
        );
      })}
    </section>
  );
}

/** 低频工作流按需挂载，关闭时不拉取插件和并行任务目录。 */
export function LeoWorkbenchMore({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const { locale } = useZCodeIntl();
  return (
    <details
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
      className="w-full max-w-2xl border-t border-border pt-3"
    >
      <summary className="flex w-fit cursor-pointer list-none items-center gap-1.5 rounded-md px-1.5 py-1 text-ui-sm text-foreground-subtle transition-colors hover:bg-hover hover:text-foreground outline-offset-4 [&::-webkit-details-marker]:hidden motion-reduce:transition-none">
        <ChevronRight
          aria-hidden="true"
          className={cn(
            "size-3.5 shrink-0 transition-transform duration-[var(--leo-dur-1)] motion-reduce:transition-none",
            open && "rotate-90",
          )}
        />
        <span>{locale.startsWith("zh") ? "更多工作流" : "More workflows"}</span>
      </summary>
      {open ? <div className="pt-3">{children}</div> : null}
    </details>
  );
}
