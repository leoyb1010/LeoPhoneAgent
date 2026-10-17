import { GitBranchPlus, GitMerge, Trash2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { Button } from "@/components/ui/button.js";
import { Checkbox } from "@/components/ui/checkbox.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.js";
import { Textarea } from "@/components/ui/textarea.js";
import { cn } from "@/components/lib/utils.js";
import { logger } from "@/logger.js";

import { useLeoHome } from "./LeoHomeContext.js";
import {
  leoTaskGroups,
  leoTaskGroupsBridge,
  openGroupsForWorkspace,
  taskGroupAgentChoices,
  type LeoTaskGroup,
  type LeoTaskGroupAgentChoice,
  type LeoTaskGroupDiff,
} from "./leoTaskGroups.js";

/**
 * [leo][WP-27] 首页「并行方案」：同一个需求同时交给几个 agent（LeoBot / Claude Code / Codex …），
 * 每个在自己的 git worktree 里做，互不干扰；做完对比改动，采纳一个落回项目，再一键清理。
 */
export function LeoTaskGroupsHome({ workspacePath, className }: { workspacePath: string; className?: string }) {
  if (!leoTaskGroupsBridge() || !workspacePath) return null;
  return <LeoTaskGroupsHomeBody workspacePath={workspacePath} className={className} />;
}

function LeoTaskGroupsHomeBody({ workspacePath, className }: { workspacePath: string; className?: string }) {
  const home = useLeoHome();
  const [groups, setGroups] = useState<LeoTaskGroup[]>([]);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [diffs, setDiffs] = useState<Record<string, LeoTaskGroupDiff | undefined>>({});

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

  return (
    <section aria-label="并行方案" className={cn("leo-task-groups w-full max-w-2xl px-1", className)}>
      <div className="flex items-center justify-between px-3">
        <span className="text-ui-caption text-foreground-subtlest">并行方案</span>
        <Button type="button" variant="ghost" size="sm" onClick={() => setDialogOpen(true)}>
          <GitBranchPlus className="mr-1.5 size-3.5" />
          让几个 agent 同时做
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
              onClick={() => void run(`cleanup:${group.id}`, () => leoTaskGroups.cleanup(group.id))}
            >
              <Trash2 className="mr-1.5 size-3.5" />
              {group.mergedMemberId ? "清理 worktree" : "放弃并清理"}
            </Button>
          </div>
          <ul className="mt-1.5 flex flex-col gap-1">
            {group.members.map((member) => {
              const diffKey = `${group.id}:${member.id}`;
              const diff = diffs[diffKey];
              return (
                <li key={member.id} className="rounded-lg bg-surface px-3 py-2">
                  <div className="flex items-center gap-2">
                    <span className="min-w-0 flex-1 truncate text-ui-sm text-foreground">
                      {member.label}
                      {member.state === "merged" ? " · 已采纳" : ""}
                      {member.error ? ` · 没开起来：${member.error}` : ""}
                    </span>
                    {member.taskId && home ? (
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() => home.onSelectTask(member.taskWorkspacePath, member.taskId!)}
                      >
                        打开
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
                      {diff ? "收起改动" : "看改动"}
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
                        采纳
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
  if (diff.files.length === 0) {
    return <p className="mt-1.5 text-ui-caption text-foreground-subtle">还没有改动。</p>;
  }
  return (
    <div className="mt-1.5 space-y-1.5">
      <p className="text-ui-caption text-foreground-subtle">
        {diff.files.length} 个文件：{diff.files.map((file) => file.path).join("、")}
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
        {diff.truncated ? <div className="text-foreground-subtle">…（改动太长，只显示前一部分）</div> : null}
      </pre>
    </div>
  );
}

function TaskGroupCreateDialog({
  open,
  onOpenChange,
  workspacePath,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workspacePath: string;
  onCreated: () => void;
}) {
  const [prompt, setPrompt] = useState("");
  const [choices, setChoices] = useState<LeoTaskGroupAgentChoice[]>(() => taskGroupAgentChoices([]));
  const [selected, setSelected] = useState<string[]>(["leo"]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    const acp = (window as unknown as { leoAcp?: { list(): Promise<Array<{ id: string; name: string; available: boolean }>> } })
      .leoAcp;
    void (acp?.list() ?? Promise.resolve([]))
      .then((agents) => setChoices(taskGroupAgentChoices(agents)))
      .catch(() => undefined);
  }, [open]);

  const toggle = (key: string, checked: boolean) =>
    setSelected((current) => (checked ? [...new Set([...current, key])] : current.filter((entry) => entry !== key)));

  const submit = async () => {
    setSubmitting(true);
    setError(null);
    try {
      await leoTaskGroups.create({
        workspacePath,
        prompt: prompt.trim(),
        agents: choices.filter((choice) => selected.includes(choice.key)).map((choice) => choice.agent),
      });
      setPrompt("");
      onOpenChange(false);
      onCreated();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl rounded-2xl p-6">
        <DialogHeader className="space-y-2">
          <DialogTitle>让几个 agent 同时做</DialogTitle>
          <DialogDescription>
            每个 agent 在这个项目的独立 git worktree 里干活，互不影响，也不碰你现在的文件。做完在首页对比改动，采纳一个落回项目。
          </DialogDescription>
        </DialogHeader>
        <Textarea
          value={prompt}
          rows={4}
          placeholder="要做什么？"
          onChange={(event) => setPrompt(event.target.value)}
        />
        <div className="flex flex-wrap gap-x-5 gap-y-2">
          {choices.map((choice) => (
            <label key={choice.key} className="flex items-center gap-2 text-ui-base text-foreground">
              <Checkbox
                checked={selected.includes(choice.key)}
                onCheckedChange={(checked) => toggle(choice.key, checked === true)}
              />
              {choice.label}
            </label>
          ))}
        </div>
        {error ? (
          <p role="alert" className="text-ui-sm text-destructive">
            {error}
          </p>
        ) : null}
        <DialogFooter>
          <Button type="button" variant="secondary" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button
            type="button"
            disabled={submitting || !prompt.trim() || selected.length === 0 || selected.length > 4}
            onClick={() => void submit()}
          >
            {submitting ? "正在准备 worktree…" : `开始（${selected.length} 个）`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
