import { useEffect, useRef, useState } from "react";
import { ArrowUp, ArrowLeft, PanelRight, MessageSquare, Users, FileText } from "lucide-react";
import type { IPaperclipWorkspace, PaperclipSnapshot } from "@zcode/services";
import { Button } from "@/components/ui/button.js";
import { Textarea } from "@/components/ui/textarea.js";
import { Dialog, DialogContent, DialogTitle, DialogDescription } from "@/components/ui/dialog.js";
import { usePaperclipDraft } from "./usePaperclipDraft.js";
import { paperclipStatus } from "./labels.js";
import { useDialogFocusReturn } from "./useDialogFocusReturn.js";
import { PaperclipInspector, type PaperclipDecision } from "./Inspector.js";

export function PaperclipIssueDetail({
  service,
  snapshot,
  invoke,
  onHome,
}: {
  service: IPaperclipWorkspace;
  snapshot: PaperclipSnapshot;
  invoke: (action: () => Promise<void>) => Promise<boolean>;
  onHome: () => void;
}) {
  const detail = snapshot.detail!;
  const { draft, update, submit, rejected, clear } = usePaperclipDraft(snapshot, detail.issue.id);
  const [decision, setDecision] = useState<PaperclipDecision | null>(null);
  const [note, setNote] = useState("");
  const [properties, setProperties] = useState(false);
  const propertiesFocus = useDialogFocusReturn(
    "[data-pc-inspector-trigger], [data-pc-home-trigger]",
  );
  const decisionFocus = useDialogFocusReturn("[data-pc-inspector-trigger], [data-pc-home-trigger]");
  const scroll = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  const assignee = snapshot.agents.find((agent) => agent.id === detail.issue.assigneeAgentId);
  useEffect(() => {
    if (follow.current) scroll.current?.scrollTo({ top: scroll.current.scrollHeight });
  }, [detail.comments.length]);
  const reply = async () => {
    if (snapshot.busy || !draft.body.trim()) return;
    const pending = submit();
    await invoke(() =>
      service.command({
        kind: "comment",
        issueId: detail.issue.id,
        requestId: pending.id,
        body: pending.body,
        retry: draft.submitted,
      }),
    );
    const receipt = service.getSnapshot().receipts[pending.id];
    if (receipt?.state === "confirmed") {
      clear();
      follow.current = true;
    } else if (receipt?.state === "rejected") rejected(draft.submitted);
  };
  const inspector = (
    <PaperclipInspector
      service={service}
      snapshot={snapshot}
      invoke={invoke}
      setDecision={setDecision}
      note={note}
      setNote={setNote}
    />
  );
  return (
    <article className="pc-enter flex min-h-0 flex-1 text-ui-base">
      <section className="flex min-h-0 min-w-0 flex-1 flex-col">
        <header className="flex shrink-0 items-center gap-3 border-b border-border px-5 py-4">
          <button
            type="button"
            className="pc-icon"
            aria-label="返回新对话首页"
            data-pc-home-trigger
            onClick={onHome}
          >
            <ArrowLeft size={17} />
          </button>
          <div className="min-w-0 flex-1">
            <p className="mb-1 flex items-center gap-2 text-ui-sm text-foreground-subtle">
              <span className={`pc-status-dot pc-status-${detail.issue.status}`} />
              {detail.issue.identifier || "任务对话"}
              <span>·</span>
              {paperclipStatus(detail.issue.status)}
            </p>
            <h1 className="break-words text-ui-lg font-semibold">{detail.issue.title}</h1>
          </div>
          <button
            className="pc-icon pc-inspector-toggle"
            type="button"
            aria-label="查看任务属性与运行记录"
            data-pc-inspector-trigger
            onClick={() => setProperties(true)}
          >
            <PanelRight size={18} />
          </button>
        </header>
        <div
          ref={scroll}
          className="pc-conversation-body min-h-0 flex-1 overflow-y-auto"
          onScroll={() => {
            const node = scroll.current;
            if (node) follow.current = node.scrollHeight - node.scrollTop - node.clientHeight < 100;
          }}
        >
          <div className="mx-auto w-full max-w-3xl space-y-7">
            <section className="pc-message">
              <div className="mb-3 flex items-center gap-2 text-ui-sm text-foreground-subtle">
                <FileText size={15} />
                <span>任务说明</span>
              </div>
              <div className="whitespace-pre-wrap break-words text-ui-base leading-relaxed">
                {detail.issue.description || "暂未补充说明。可以在下方发送背景、要求与验收条件。"}
              </div>
            </section>
            <div className="flex items-center gap-3">
              <span className="h-px flex-1 bg-border" />
              <span className="text-ui-sm text-foreground-subtlest">对话与进展</span>
              <span className="h-px flex-1 bg-border" />
            </div>
            {detail.comments.length === 0 && (
              <div className="flex items-start gap-3 py-2 text-foreground-subtle">
                <MessageSquare size={18} className="mt-0.5 shrink-0" />
                <p className="text-ui-caption leading-relaxed">
                  还没有回复。补充要求，或等待服务器代理的进展。
                </p>
              </div>
            )}
            {detail.comments.map((comment) => {
              // 作者来自服务器字段；仅已确认本机请求编号可补证本人身份，缺失作者不能伪装成 AI。
              const own =
                comment.authorUserId === snapshot.user?.id ||
                Boolean(
                  comment.clientRequestId &&
                  snapshot.receipts[comment.clientRequestId]?.state === "confirmed" &&
                  snapshot.receipts[comment.clientRequestId]?.kind === "comment",
                );
              const agent = snapshot.agents.find((item) => item.id === comment.authorAgentId);
              const author = own
                ? snapshot.user?.name || "你"
                : agent?.name ||
                  (comment.authorAgentId
                    ? "服务器代理"
                    : comment.authorUserId
                      ? "团队成员"
                      : "服务器留言");
              const date = comment.createdAt ? new Date(comment.createdAt) : null;
              const time =
                date && Number.isFinite(date.getTime())
                  ? date.toLocaleString(undefined, {
                      month: "numeric",
                      day: "numeric",
                      hour: "2-digit",
                      minute: "2-digit",
                    })
                  : null;
              return (
                <section
                  className={`pc-message flex flex-col ${own ? "items-end" : "items-start"}`}
                  key={comment.id}
                >
                  <div className="mb-2 flex items-center gap-2 text-ui-sm text-foreground-subtle">
                    {!own && <Users size={13} />}
                    <span>{author}</span>
                    {time && (
                      <time dateTime={comment.createdAt!} className="text-foreground-subtlest">
                        {time}
                      </time>
                    )}
                  </div>
                  <div
                    className={`max-w-[90%] whitespace-pre-wrap break-words rounded-xl px-4 py-3 text-ui-base leading-relaxed ${own ? "pc-human-message" : "bg-surface"}`}
                  >
                    {comment.body}
                  </div>
                </section>
              );
            })}
          </div>
        </div>
        <footer className="shrink-0 bg-background px-5 pb-5 pt-2">
          <div className="mx-auto w-full max-w-3xl">
            {draft.submitted && (
              <div
                role="status"
                className="mb-3 flex flex-wrap items-center gap-2 text-ui-caption text-warning"
              >
                <span className="min-w-0 flex-1">原回复结果待核对。重试沿用原请求编号。</span>
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
            )}
            <form
              className="pc-composer rounded-xl p-3"
              onSubmit={(event) => {
                event.preventDefault();
                void reply();
              }}
            >
              <label className="sr-only" htmlFor="pc-reply">
                补充要求或回复
              </label>
              <Textarea
                id="pc-reply"
                rows={3}
                className="min-h-20 text-ui-base leading-relaxed"
                value={draft.body}
                disabled={snapshot.busy || draft.submitted}
                placeholder="继续这段对话，补充目标或反馈…"
                onChange={(event) => update({ body: event.target.value })}
                onKeyDown={(event) => {
                  if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
                    event.preventDefault();
                    void reply();
                  }
                }}
              />
              <div className="flex items-center gap-2 pt-2">
                <Users size={14} className="text-foreground-subtle" />
                <span className="min-w-0 flex-1 truncate text-ui-caption text-foreground-subtle">
                  {assignee?.name || "发送到任务对话"}
                </span>
                <span className="hidden text-ui-xs text-foreground-subtlest sm:inline">
                  ⌘ / Ctrl + Enter
                </span>
                <button
                  type="submit"
                  className="pc-send"
                  aria-label={draft.submitted ? "重试同一回复" : "发送回复"}
                  disabled={snapshot.busy || !draft.body.trim()}
                >
                  <ArrowUp size={19} />
                </button>
              </div>
            </form>
          </div>
        </footer>
      </section>
      <aside
        className="pc-inspector shrink-0 overflow-y-auto border-l border-border bg-background-alt px-5 py-5"
        aria-label="任务属性与运行记录"
      >
        {inspector}
      </aside>
      <Dialog open={properties} onOpenChange={setProperties}>
        <DialogContent className="pc-inspector-dialog p-5" {...propertiesFocus}>
          <DialogTitle className="pr-8 text-ui-lg">任务详情</DialogTitle>
          <DialogDescription className="sr-only">状态、审批、运行记录与附件。</DialogDescription>
          {inspector}
        </DialogContent>
      </Dialog>
      <Dialog
        open={decision !== null}
        onOpenChange={(open) => {
          if (!open) setDecision(null);
        }}
      >
        <DialogContent {...decisionFocus}>
          <DialogTitle>{decision?.title}</DialogTitle>
          <DialogDescription>
            这会更改绑定服务器的真实状态，请先核对任务和审批内容。
          </DialogDescription>
          {decision?.preview && (
            <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words text-ui-caption">
              {decision.preview}
            </pre>
          )}
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setDecision(null)}>
              取消
            </Button>
            <Button
              onClick={() => {
                if (decision) void invoke(() => service.command(decision.command));
                setDecision(null);
              }}
            >
              确认
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </article>
  );
}
