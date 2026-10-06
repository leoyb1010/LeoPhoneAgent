import { useState } from "react";
import { ArrowUp, ChevronDown, Users, Sparkles } from "lucide-react";
import type { IPaperclipWorkspace, PaperclipSnapshot } from "@zcode/services";
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import { Textarea } from "@/components/ui/textarea.js";
import { PAPERCLIP_CREATE_RETRY_WINDOW_DAYS } from "@zcode/shared";
import { usePaperclipDraft } from "./usePaperclipDraft.js";

export function PaperclipCreateIssue({
  service,
  snapshot,
  invoke,
  onClose,
}: {
  service: IPaperclipWorkspace;
  snapshot: PaperclipSnapshot;
  invoke: (action: () => Promise<void>) => Promise<boolean>;
  onClose: () => void;
}) {
  const { draft, update, submit, rejected, clear, creationRetryAllowed } =
    usePaperclipDraft(snapshot);
  const [details, setDetails] = useState(false);
  const company = snapshot.companies.find((item) => item.id === snapshot.companyId);
  const send = async () => {
    if (!creationRetryAllowed || snapshot.busy || snapshot.ready === false || !draft.title.trim())
      return;
    const pending = submit();
    await invoke(() =>
      service.command({
        kind: "create",
        requestId: pending.id,
        firstSubmittedAt: pending.submittedAt!,
        retry: draft.submitted,
        title: pending.title.trim(),
        description: pending.body,
        agentId: pending.agentId || undefined,
      }),
    );
    const receipt = service.getSnapshot().receipts[pending.id];
    if (receipt?.state === "confirmed") {
      clear();
      onClose();
    } else if (receipt?.state === "rejected") rejected(draft.submitted);
  };
  return (
    <section className="pc-enter flex min-h-0 flex-1 flex-col overflow-y-auto px-5 py-6 text-ui-base">
      <div className="mx-auto flex w-full max-w-2xl flex-1 flex-col justify-center pb-8">
        <div className="mb-8">
          <span className="mb-5 flex size-10 items-center justify-center rounded-xl bg-accent text-brand">
            <Sparkles size={20} strokeWidth={1.6} />
          </span>
          <p className="mb-3 text-ui-sm text-foreground-subtle">
            {company?.name || "你的团队"} · 新对话
          </p>
          <h1 className="text-ui-xl font-semibold tracking-tight">今天，想让团队完成什么？</h1>
          <p className="mt-3 text-ui-base leading-relaxed text-foreground-subtle">
            写下目标、补充背景，然后把它交给合适的智能体。
          </p>
        </div>
        <form
          className="pc-composer flex flex-col gap-2 rounded-xl p-4"
          onSubmit={(event) => {
            event.preventDefault();
            void send();
          }}
        >
          <label className="sr-only" htmlFor="pc-create-title">
            任务标题
          </label>
          <Input
            id="pc-create-title"
            className="h-11 border-0 bg-transparent px-1 text-ui-base font-medium shadow-none focus-visible:ring-0"
            placeholder="给这段任务对话起个名字…"
            value={draft.title}
            disabled={snapshot.busy || draft.submitted}
            onChange={(event) => update({ title: event.target.value })}
          />
          <label className="sr-only" htmlFor="pc-create-body">
            任务说明与验收条件
          </label>
          <Textarea
            id="pc-create-body"
            className="min-h-32 px-1 text-ui-base leading-relaxed"
            rows={5}
            placeholder="例如：研究这个项目，整理关键发现，并提出可以落地的改进方案。"
            value={draft.body}
            disabled={snapshot.busy || draft.submitted}
            onChange={(event) => update({ body: event.target.value })}
            onKeyDown={(event) => {
              if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
                event.preventDefault();
                void send();
              }
            }}
          />
          <div className="flex items-center gap-3 border-t border-border pt-3">
            <Users size={15} className="shrink-0 text-foreground-subtle" />
            <label className="min-w-0 flex-1">
              <span className="sr-only">执行智能体</span>
              <select
                aria-label="执行智能体"
                className="max-w-full rounded-lg bg-transparent py-1.5 pr-2 text-ui-caption text-foreground-subtle outline-none"
                value={draft.agentId}
                disabled={snapshot.busy || draft.submitted}
                onChange={(event) => update({ agentId: event.target.value })}
              >
                <option value="">暂不分配 · 先规划</option>
                {snapshot.agents
                  .filter((agent) => agent.status !== "terminated")
                  .map((agent) => (
                    <option key={agent.id} value={agent.id}>
                      {agent.name}
                    </option>
                  ))}
              </select>
            </label>
            <button
              type="submit"
              className="pc-send"
              aria-label={draft.submitted ? "重试同一创建" : "创建任务"}
              disabled={
                snapshot.busy ||
                snapshot.ready === false ||
                !creationRetryAllowed ||
                !draft.title.trim()
              }
            >
              <ArrowUp size={19} />
            </button>
          </div>
        </form>
        <div className="mt-3 flex items-center justify-between gap-3 px-1 text-ui-sm text-foreground-subtlest">
          <span>
            {draft.agentId
              ? "交给所选服务器智能体，按团队规则执行"
              : "创建待规划任务，不会唤醒智能体"}
          </span>
          <span className="shrink-0">⌘ / Ctrl + Enter</span>
        </div>
        {draft.submitted && (
          <div
            role="status"
            className="mt-5 space-y-3 rounded-xl border border-border bg-surface p-4 text-ui-caption"
          >
            <p className="text-warning">
              {creationRetryAllowed
                ? `提交结果待核对。重试会保留原请求编号；首次提交后 ${PAPERCLIP_CREATE_RETRY_WINDOW_DAYS} 天内可以重试。`
                : "原请求已超出去重期限或缺少可信时间，不能重发。任务内容已保留，请先核对服务器。"}
            </p>
            <div className="flex flex-wrap gap-2">
              <Button
                variant="outline"
                disabled={snapshot.busy || snapshot.ready === false || !creationRetryAllowed}
                onClick={() => void send()}
              >
                重试同一创建
              </Button>
              <Button
                variant="ghost"
                disabled={snapshot.busy}
                onClick={() =>
                  void invoke(async () => {
                    if (snapshot.receipts[draft.id]?.state === "unknown")
                      await service.command({ kind: "archive", receiptId: draft.id });
                    clear();
                  })
                }
              >
                已核对，放弃草稿
              </Button>
            </div>
          </div>
        )}
        <button
          className="mt-7 flex items-center gap-2 self-start text-ui-sm text-foreground-subtle"
          type="button"
          aria-expanded={details}
          onClick={() => setDetails(!details)}
        >
          <ChevronDown size={14} className={details ? "rotate-180" : ""} />
          任务如何执行？
        </button>
        {details && (
          <p className="pc-enter mt-3 max-w-lg text-ui-caption leading-relaxed text-foreground-subtle">
            任务提交到当前公司。指定智能体后，服务器按自身的调度与审批规则执行。没有分配智能体的任务保留为待规划；创建成功不会伪装成已经开始运行。
          </p>
        )}
      </div>
    </section>
  );
}
