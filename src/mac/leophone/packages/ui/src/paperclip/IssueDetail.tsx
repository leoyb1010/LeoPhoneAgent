import { useState } from "react";
import type { IPaperclipWorkspace, PaperclipCommand, PaperclipSnapshot } from "@zcode/services";
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import { Textarea } from "@/components/ui/textarea.js";
import { Dialog, DialogContent, DialogTitle, DialogDescription } from "@/components/ui/dialog.js";
import { usePaperclipDraft } from "./usePaperclipDraft.js";
import { paperclipIssueStatuses, paperclipStatus } from "./labels.js";

export function PaperclipIssueDetail({
  service,
  snapshot,
  invoke,
}: {
  service: IPaperclipWorkspace;
  snapshot: PaperclipSnapshot;
  invoke: (action: () => Promise<void>) => Promise<boolean>;
}) {
  const detail = snapshot.detail!;
  const { draft, update, submit, rejected, clear } = usePaperclipDraft(snapshot, detail.issue.id);
  const [decision, setDecision] = useState<{ title: string; command: PaperclipCommand } | null>(
    null,
  );
  const [note, setNote] = useState("");
  const reply = async () => {
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
    if (receipt?.state === "confirmed") clear();
    else if (receipt?.state === "rejected") rejected(draft.submitted);
  };
  return (
    <article className="mx-auto flex w-full max-w-4xl flex-col gap-6 p-5 text-ui-base">
      <section className="flex flex-col gap-3">
        <p className="text-ui-caption text-foreground-subtle">
          {detail.issue.identifier ?? "服务器任务"} · {paperclipStatus(detail.issue.status)}
        </p>
        <h2 className="break-words text-ui-xl font-semibold">{detail.issue.title}</h2>
        <p className="whitespace-pre-wrap break-words">
          {detail.issue.description || "暂无任务说明"}
        </p>
        <label className="flex items-center gap-2">
          更改状态
          <select
            className="rounded-md border border-input-border bg-input p-2 text-ui-base"
            value={detail.issue.status}
            disabled={snapshot.busy}
            onChange={(event) =>
              setDecision({
                title: `将任务设为「${paperclipStatus(event.target.value)}」？`,
                command: { kind: "status", issueId: detail.issue.id, status: event.target.value },
              })
            }
          >
            {paperclipIssueStatuses.map((status) => (
              <option key={status} value={status}>
                {paperclipStatus(status)}
              </option>
            ))}
          </select>
        </label>
      </section>
      <section className="flex flex-col gap-3 border-t border-border pt-4">
        <h3 className="text-ui-lg font-semibold">任务对话</h3>
        {detail.comments.length === 0 && <p className="text-foreground-subtle">暂无回复</p>}
        {detail.comments.map((comment) => (
          <p key={comment.id} className="whitespace-pre-wrap break-words rounded-md bg-surface p-3">
            {comment.body}
          </p>
        ))}
        <label className="flex flex-col gap-2">
          补充要求或回复
          <Textarea
            rows={4}
            value={draft.body}
            disabled={snapshot.busy || draft.submitted}
            onChange={(event) => update({ body: event.target.value })}
          />
        </label>
        {draft.submitted && (
          <p className="text-ui-caption text-warning">
            原提交结果待核对，请先刷新。手动重试沿用原请求编号。
          </p>
        )}
        <div className="flex gap-2">
          <Button disabled={snapshot.busy || !draft.body.trim()} onClick={() => void reply()}>
            {draft.submitted ? "重试同一回复" : "发送回复"}
          </Button>
          {draft.submitted && (
            <Button variant="outline" disabled={snapshot.busy} onClick={clear}>
              已核对，放弃草稿
            </Button>
          )}
        </div>
      </section>
      <section className="flex flex-col gap-3 border-t border-border pt-4">
        <h3 className="text-ui-lg font-semibold">关联审批</h3>
        {detail.approvals.length === 0 && <p className="text-foreground-subtle">暂无关联审批</p>}
        {detail.approvals.map((approval) => (
          <details key={approval.id} className="rounded-md border border-border p-3">
            <summary className="cursor-pointer">
              {approval.type === "hire_agent" ? "聘用代理" : "服务器审批"} ·{" "}
              {paperclipStatus(approval.status)}
            </summary>
            <pre className="my-3 whitespace-pre-wrap break-words text-ui-caption">
              {JSON.stringify(approval.payload, null, 2)}
            </pre>
            {approval.decisionNote && <p className="mb-3">决定说明：{approval.decisionNote}</p>}
            {approval.status === "pending" && (
              <div className="flex flex-col gap-2">
                <Input
                  aria-label="决定说明"
                  placeholder="决定说明（可选）"
                  value={note}
                  disabled={snapshot.busy}
                  onChange={(event) => setNote(event.target.value)}
                />
                <div className="flex gap-2">
                  {[true, false].map((approve) => (
                    <Button
                      key={String(approve)}
                      variant={approve ? "default" : "outline"}
                      disabled={snapshot.busy}
                      onClick={() =>
                        setDecision({
                          title: approve ? "确认批准此请求？" : "确认拒绝此请求？",
                          command: {
                            kind: "approval",
                            issueId: detail.issue.id,
                            approvalId: approval.id,
                            approve,
                            note,
                          },
                        })
                      }
                    >
                      {approve ? "批准" : "拒绝"}
                    </Button>
                  ))}
                </div>
              </div>
            )}
          </details>
        ))}
      </section>
      <section className="flex flex-col gap-3 border-t border-border pt-4">
        <h3 className="text-ui-lg font-semibold">运行记录</h3>
        {detail.runs.length === 0 && (
          <p className="text-foreground-subtle">尚无运行记录。创建任务不代表代理已经开始执行。</p>
        )}
        {detail.runs.map((run) => (
          <div
            key={run.runId}
            className="flex flex-wrap items-center gap-2 rounded-md bg-surface p-3"
          >
            <span className="min-w-0 flex-1 break-all">
              {paperclipStatus(run.status)} · {run.runId}
            </span>
            <Button
              variant="outline"
              disabled={snapshot.busy}
              onClick={() => void invoke(() => service.readLog(run.runId))}
            >
              读取日志
            </Button>
            {["queued", "running"].includes(run.status) && (
              <Button
                variant="outline"
                disabled={snapshot.busy}
                onClick={() =>
                  setDecision({
                    title: "确认取消此服务器运行？",
                    command: { kind: "cancel", issueId: detail.issue.id, runId: run.runId },
                  })
                }
              >
                取消运行
              </Button>
            )}
          </div>
        ))}
        {snapshot.log && (
          <div>
            <p className="mb-2 text-ui-caption text-foreground-subtle">
              日志开头最多 64 KB，原始输出可能包含英文。
            </p>
            <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-words rounded-md bg-surface p-3 text-ui-caption">
              {snapshot.log.content || "暂无日志内容"}
            </pre>
          </div>
        )}
      </section>
      <section className="flex flex-col gap-3 border-t border-border pt-4">
        <h3 className="text-ui-lg font-semibold">服务器附件</h3>
        <p className="text-ui-caption text-foreground-subtle">
          只显示此任务的服务器附件。下载通过系统另存为保存，不会自动打开或执行。
        </p>
        {detail.attachments.length === 0 && (
          <p className="text-foreground-subtle">暂无可下载附件</p>
        )}
        {detail.attachments.map((attachment) => (
          <div key={attachment.id} className="flex items-center gap-3">
            <span className="min-w-0 flex-1 break-words">
              {attachment.originalFilename ?? "服务器附件"} ·{" "}
              {Math.ceil(attachment.byteSize / 1024)} KB
            </span>
            <Button
              variant="outline"
              disabled={snapshot.busy}
              onClick={() => void invoke(() => service.downloadAttachment(attachment.id))}
            >
              下载附件
            </Button>
          </div>
        ))}
      </section>
      <Dialog
        open={decision !== null}
        onOpenChange={(open) => {
          if (!open) setDecision(null);
        }}
      >
        <DialogContent>
          <DialogTitle>{decision?.title}</DialogTitle>
          <DialogDescription>
            这会更改绑定服务器的真实状态，请先核对任务和审批内容。
          </DialogDescription>
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
