import { GitBranchPlus, GitMerge, Trash2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { Button } from "@/components/ui/button.js";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";

import { useLeoHomeTasks } from "./LeoDraftStatusList.js";
import { useLeoHome, type LeoHomeContextValue } from "./LeoHomeContext.js";
import { classifyLeoStatusRows, type LeoStatusRow } from "./leoStatusRows.js";
import { TaskGroupCreateDialog } from "./LeoTaskGroupCreateDialog.js";
import {
  leoTaskGroups,
  leoTaskGroupsBridge,
  openGroupsForWorkspace,
  type LeoTaskGroup,
  type LeoTaskGroupDiff,
} from "./leoTaskGroups.js";

/**
 * [leo][WP-27] 首页「并行方案」：同一个需求同时交给几个 agent（LeoBot / Claude Code / Codex …），
 * 每个在自己的 git worktree 里做，互不干扰；做完对比改动，采纳一个落回项目，再一键清理。
 */
export function LeoTaskGroupsHome({ workspacePath, className }: { workspacePath: string; className?: string }) {
  const home = useLeoHome();
  if (!leoTaskGroupsBridge() || !workspacePath) return null;
  if (home) {
    return <LeoTaskGroupsHomeWithLiveStatus home={home} workspacePath={workspacePath} className={className} />;
  }
  return <LeoTaskGroupsHomeBody home={null} statusByTaskId={EMPTY_STATUS_MAP} workspacePath={workspacePath} className={className} />;
}

const EMPTY_STATUS_MAP = new Map<string, LeoStatusRow>();

function LeoTaskGroupsHomeWithLiveStatus({
  home,
  workspacePath,
  className,
}: {
  home: LeoHomeContextValue;
  workspacePath: string;
  className?: string;
}) {
  const { items } = useLeoHomeTasks(home);
  const statusByTaskId = useMemo(() => {
    const map = new Map<string, LeoStatusRow>();
    for (const row of classifyLeoStatusRows(items)) {
      map.set(row.task.taskId, row);
    }
    return map;
  }, [items]);
  return (
    <LeoTaskGroupsHomeBody
      home={home}
      statusByTaskId={statusByTaskId}
      workspacePath={workspacePath}
      className={className}
    />
  );
}

function LeoTaskGroupsHomeBody({
  home,
  statusByTaskId,
  workspacePath,
  className,
}: {
  home: LeoHomeContextValue | null;
  statusByTaskId: ReadonlyMap<string, LeoStatusRow>;
  workspacePath: string;
  className?: string;
}) {
  const { intl } = useZCodeIntl();
  const [groups, setGroups] = useState<LeoTaskGroup[]>([]);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [diffs, setDiffs] = useState<Record<string, LeoTaskGroupDiff | undefined>>({});
  const prevRunningIdsRef = useRef<Set<string>>(new Set());

  const refresh = useCallback(async () => {
    try {
      setGroups(await leoTaskGroups.list());
    } catch (cause) {
      logger.warn("[LeoTaskGroupsHome] list failed", cause);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const onFocus = () => void refresh();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [refresh]);

  const run = useCallback(
    async (key: string, work: () => Promise<unknown>) => {
      setBusy(key);
      setError(null);
      try {
        await work();
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        setBusy(null);
        await refresh();
      }
    },
    [refresh],
  );

  const visible = useMemo(() => openGroupsForWorkspace(groups, workspacePath), [groups, workspacePath]);

  // Auto-refresh open diffs when a running member finishes.
  useEffect(() => {
    const runningNow = new Set<string>();
    const finishedMembers: Array<{ groupId: string; memberId: string; diffKey: string }> = [];
    for (const group of visible) {
      for (const member of group.members) {
        if (!member.taskId) continue;
        const live = statusByTaskId.get(member.taskId);
        const key = `${group.id}:${member.id}`;
        if (live?.state === "running") {
          runningNow.add(key);
        } else if (prevRunningIdsRef.current.has(key) && diffs[key]) {
          finishedMembers.push({ groupId: group.id, memberId: member.id, diffKey: key });
        }
      }
    }
    prevRunningIdsRef.current = runningNow;
    for (const item of finishedMembers) {
      void leoTaskGroups
        .diff(item.groupId, item.memberId)
        .then((next) => setDiffs((current) => (current[item.diffKey] ? { ...current, [item.diffKey]: next } : current)))
        .catch(() => undefined);
    }
  }, [diffs, statusByTaskId, visible]);

  return (
    <section
      aria-label={intl.formatMessage({ id: "leoHome.taskGroups.title" })}
      className={cn("leo-task-groups w-full max-w-2xl px-1", className)}
    >
      <div className="flex items-center justify-between px-3">
        <span className="text-ui-caption text-foreground-subtlest">
          {intl.formatMessage({ id: "leoHome.taskGroups.title" })}
        </span>
        <Button type="button" variant="ghost" size="sm" onClick={() => setDialogOpen(true)}>
          <GitBranchPlus className="mr-1.5 size-3.5" />
          {intl.formatMessage({ id: "leoHome.taskGroups.create" })}
        </Button>
      </div>
      {error ? (
        <p role="alert" className="px-3 py-1 text-ui-caption text-destructive">
          {error}
        </p>
      ) : null}
      {visible.map((group) => (
        <div key={group.id} className="mt-2 rounded-xl border border-border px-3 py-2.5" data-task-group={group.id}>
          <div className="flex items-center gap-2">
            <span className="min-w-0 flex-1 truncate text-ui-base font-medium text-foreground">{group.title}</span>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={busy !== null}
              onClick={() =>
                void run(`cleanup:${group.id}`, async () => {
                  await leoTaskGroups.cleanup(group.id);
                  home?.onCloseWorkspaces?.(group.members.map((member) => member.worktreePath));
                })
              }
            >
              <Trash2 className="mr-1.5 size-3.5" />
              {intl.formatMessage({
                id: group.mergedMemberId
                  ? "leoHome.taskGroups.cleanupWorktree"
                  : "leoHome.taskGroups.discardAndCleanup",
              })}
            </Button>
          </div>
          <ul className="mt-1.5 flex flex-col gap-1">
            {group.members.map((member) => {
              const diffKey = `${group.id}:${member.id}`;
              const diff = diffs[diffKey];
              const liveStatus = member.taskId ? statusByTaskId.get(member.taskId) : undefined;
              return (
                <li key={member.id} className="rounded-lg bg-surface px-3 py-2">
                  <div className="flex items-center gap-2">
                    {liveStatus ? (
                      <span
                        aria-hidden="true"
                        data-state={liveStatus.state}
                        className="leo-status-dot size-1.5 shrink-0 rounded-full"
                      />
                    ) : null}
                    <span className="min-w-0 flex-1 truncate text-ui-sm text-foreground">
                      {member.label}
                      {member.state === "merged" ? intl.formatMessage({ id: "leoHome.taskGroups.merged" }) : ""}
                      {member.error
                        ? intl.formatMessage({ id: "leoHome.taskGroups.startFailed" }, { error: member.error })
                        : ""}
                    </span>
                    {liveStatus ? (
                      <span
                        className={cn(
                          "shrink-0 text-ui-caption",
                          liveStatus.state === "attention"
                            ? "text-[var(--leo-attention)]"
                            : liveStatus.state === "error"
                              ? "text-destructive"
                              : "text-foreground-subtle",
                        )}
                      >
                        {intl.formatMessage({ id: liveStatus.labelId })}
                      </span>
                    ) : null}
                    {member.taskId && home ? (
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() =>
                          home.onOpenWorkspaceTask
                            ? home.onOpenWorkspaceTask(member.taskWorkspacePath, member.taskId!)
                            : home.onSelectTask(member.taskWorkspacePath, member.taskId!)
                        }
                      >
                        {intl.formatMessage({ id: "leoHome.taskGroups.open" })}
                      </Button>
                    ) : null}
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      disabled={busy !== null || member.state === "removed"}
                      onClick={() =>
                        diff
                          ? setDiffs((current) => ({ ...current, [diffKey]: undefined }))
                          : void run(`diff:${diffKey}`, async () => {
                              const next = await leoTaskGroups.diff(group.id, member.id);
                              setDiffs((current) => ({ ...current, [diffKey]: next }));
                            })
                      }
                    >
                      {intl.formatMessage({
                        id: diff ? "leoHome.taskGroups.hideDiff" : "leoHome.taskGroups.showDiff",
                      })}
                    </Button>
                    {!group.mergedMemberId && member.state === "active" ? (
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        disabled={busy !== null}
                        onClick={() => void run(`merge:${diffKey}`, () => leoTaskGroups.merge(group.id, member.id))}
                      >
                        <GitMerge className="mr-1.5 size-3.5" />
                        {intl.formatMessage({ id: "leoHome.taskGroups.adopt" })}
                      </Button>
                    ) : null}
                  </div>
                  {diff ? <TaskGroupDiffView diff={diff} /> : null}
                </li>
              );
            })}
          </ul>
        </div>
      ))}
      <TaskGroupCreateDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        workspacePath={workspacePath}
        onCreated={() => void refresh()}
      />
    </section>
  );
}

function TaskGroupDiffView({ diff }: { diff: LeoTaskGroupDiff }) {
  const { intl, locale } = useZCodeIntl();
  if (diff.files.length === 0) {
    return (
      <p className="mt-1.5 text-ui-caption text-foreground-subtle">
        {intl.formatMessage({ id: "leoHome.taskGroups.noDiff" })}
      </p>
    );
  }
  const fileSep = locale.startsWith("zh") ? "、" : ", ";
  return (
    <div className="mt-1.5 space-y-1.5">
      <p className="text-ui-caption text-foreground-subtle">
        {intl.formatMessage(
          { id: "leoHome.taskGroups.filesCount" },
          { count: diff.files.length, files: diff.files.map((file) => file.path).join(fileSep) },
        )}
      </p>
      <pre className="max-h-72 overflow-auto rounded-lg border border-border bg-panel px-3 py-2 font-mono text-ui-sm">
        {diff.patch.split("\n").map((line, index) => (
          <div
            key={index}
            className={cn(
              line.startsWith("+") && !line.startsWith("+++") && "text-success",
              line.startsWith("-") && !line.startsWith("---") && "text-destructive",
            )}
          >
            {line || " "}
          </div>
        ))}
        {diff.truncated ? (
          <div className="text-foreground-subtle">
            {intl.formatMessage({ id: "leoHome.taskGroups.truncated" })}
          </div>
        ) : null}
      </pre>
    </div>
  );
}
