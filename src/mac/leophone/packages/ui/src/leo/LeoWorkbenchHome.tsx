import { useState, type ReactNode } from "react";
import { ArrowUpRight, Code2, FileSearch, SquareTerminal } from "lucide-react";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useZCodeSessionStore } from "@/store/zcodeSessionStore.js";
import { LEO_WORKBENCH_STARTERS } from "./leoWorkbenchPrompts.js";

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
        "leo-workbench-starters grid w-full max-w-2xl grid-cols-1 gap-2 @2xl/conversation:grid-cols-3",
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
                      ? "Create a refined, minimal interactive single-file HTML page with all CSS/JS inline and no external URLs, CDNs, fonts or images; use inline SVG or data URIs. Write real runnable files, check desktop and narrow layouts, buttons and page errors, then provide a preview and downloadable output."
                      : starter.id === "code"
                        ? "Read this project's rules and relevant code, preserve existing edits, implement my changes and run the relevant checks. My goal is:"
                        : "Research the supplied material, distinguish facts and inferences, retain sources and produce a clear report with suitable HTML, Markdown or structured data files. My topic is:",
                  workspaceIdentity,
                  undefined,
                  "append-if-missing",
                )
            }
            className="group flex min-h-20 items-center gap-3 rounded-xl border border-border bg-background px-4 py-3 text-left transition-colors hover:border-border-hover hover:bg-surface focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand motion-reduce:transition-none"
          >
            <Icon aria-hidden="true" className="size-4 shrink-0 text-brand" />
            <span className="min-w-0 flex-1">
              <span className="block text-ui-caption font-medium text-foreground">
                {zh ? starter.title : starter.en}
              </span>
              <span className="mt-1 block text-ui-sm leading-relaxed text-foreground-subtle">
                {zh ? starter.description : starter.enDescription}
              </span>
            </span>
            <ArrowUpRight
              aria-hidden="true"
              className="size-3.5 shrink-0 text-foreground-subtle opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100 motion-reduce:transition-none"
            />
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
      <summary className="w-fit cursor-pointer rounded-md px-1 py-1 text-ui-sm text-foreground-subtle outline-offset-4">
        {locale.startsWith("zh") ? "更多工作流" : "More workflows"}
      </summary>
      {open ? <div className="pt-3">{children}</div> : null}
    </details>
  );
}
