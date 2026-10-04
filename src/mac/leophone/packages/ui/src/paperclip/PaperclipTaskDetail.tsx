import { useState } from "react";
import {
  paperclipLabel,
  paperclipApprovalFingerprint,
  type PaperclipCommand,
  type PaperclipDetail,
  type PaperclipSnapshot,
} from "@zcode/services/paperclip";
import { Button } from "../components/ui/button.js";
import { Textarea } from "../components/ui/textarea.js";

export interface PaperclipTaskDetailProps {
  detail: PaperclipDetail;
  log: PaperclipSnapshot["log"];
  disabled: boolean;
  onCommand: (command: PaperclipCommand) => Promise<boolean>;
  onLog: (runId: string) => void;
  onDownload: (attachmentId: string) => void;
  onDocument: (key: string) => Promise<string | null>;
}
const statuses = ["backlog", "todo", "in_progress", "in_review", "done", "blocked", "cancelled"];
const selectClass = "rounded-lg border border-input-border bg-input px-2 py-1 text-ui-base";
export function PaperclipTaskDetail({
  detail,
  log,
  disabled,
  onCommand,
  onLog,
  onDownload,
  onDocument,
}: PaperclipTaskDetailProps) {
  const [tab, setTab] = useState("conversation");
  const [reply, setReply] = useState("");
  const [status, setStatus] = useState(detail.issue.status);
  const [confirmation, setConfirmation] = useState<PaperclipCommand | null>(null);
  const [note, setNote] = useState("");
  const [document, setDocument] = useState<{ title: string; body: string } | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const locked = disabled || submitting;
  async function send(command: PaperclipCommand) {
    if (submitting) return false;
    setSubmitting(true);
    try {
      return await onCommand(command);
    } finally {
      setSubmitting(false);
    }
  }
  return (
    <section className="flex min-h-0 min-w-0 flex-1 flex-col bg-background" aria-label="任务详情">
      <div className="space-y-3 border-b border-border p-4">
        <div className="text-ui-sm text-foreground-subtle">
          {detail.issue.identifier || "服务器任务"} · {paperclipLabel(detail.issue.status)}
        </div>
        <h2 className="break-words text-ui-lg font-medium">{detail.issue.title}</h2>
        <div className="flex flex-wrap items-center gap-2">
          <label htmlFor="paperclip-status" className="text-ui-sm">
            任务状态
          </label>
          <select
            id="paperclip-status"
            value={status}
            onChange={(e) => setStatus(e.target.value)}
            className={selectClass}
            disabled={locked}
          >
            {statuses.map((s) => (
              <option key={s} value={s}>
                {paperclipLabel(s)}
              </option>
            ))}
          </select>
          <Button
            variant="outline"
            size="sm"
            disabled={locked || status === detail.issue.status}
            onClick={() => setConfirmation({ kind: "status", issueId: detail.issue.id, status })}
          >
            更新状态
          </Button>
        </div>
        <div role="tablist" aria-label="任务内容" className="flex flex-wrap gap-2">
          {[
            ["conversation", "对话"],
            ["runs", "运行与日志"],
            [
              "approvals",
              `审批（${detail.approvals.filter((a) => a.status === "pending").length}）`,
            ],
            ["artifacts", "成果与附件"],
          ].map(([value, label]) => (
            <Button
              key={value}
              role="tab"
              aria-selected={tab === value}
              variant={tab === value ? "secondary" : "ghost"}
              onClick={() => setTab(value!)}
            >
              {label}
            </Button>
          ))}
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-4" role="tabpanel">
        {tab === "conversation" && (
          <div className="space-y-4">
            {detail.issue.description && (
              <article className="whitespace-pre-wrap break-words rounded-xl border border-card-border bg-card p-4">
                <h3 className="mb-2 text-ui-sm font-medium">任务说明</h3>
                {detail.issue.description}
              </article>
            )}
            {detail.comments.length === 0 && (
              <p className="text-foreground-subtle">
                还没有回复。任务由服务器上的执行者处理，你可以在这里补充要求
              </p>
            )}
            {detail.comments.map((comment) => (
              <article
                key={comment.id}
                className="rounded-xl border border-card-border bg-card p-4"
              >
                <div className="mb-2 text-ui-sm text-foreground-subtle">
                  {comment.authorUserId ? "用户" : "执行者"}
                  {comment.createdAt
                    ? ` · ${new Date(comment.createdAt).toLocaleString("zh-CN")}`
                    : ""}
                </div>
                <div className="whitespace-pre-wrap break-words">{comment.body}</div>
              </article>
            ))}
            {detail.comments.length === 100 && (
              <p className="text-ui-sm text-foreground-subtle">当前显示最近 100 条回复</p>
            )}
            <form
              className="space-y-2"
              onSubmit={(event) => {
                event.preventDefault();
                const body = reply.trim();
                if (body)
                  void send({ kind: "reply", issueId: detail.issue.id, body }).then((ok) => {
                    if (ok) setReply("");
                  });
              }}
            >
              <label htmlFor="paperclip-reply" className="font-medium">
                回复任务
              </label>
              <Textarea
                id="paperclip-reply"
                placeholder="补充要求或回答执行者的问题…"
                value={reply}
                onChange={(e) => setReply(e.target.value)}
                disabled={locked}
                maxLength={100000}
              />
              <Button type="submit" disabled={locked || !reply.trim()}>
                {submitting ? "提交中…" : "发送回复"}
              </Button>
            </form>
          </div>
        )}
        {tab === "runs" && (
          <div className="space-y-3">
            <p className="text-ui-sm text-foreground-subtle">
              运行发生在服务器的执行环境中；取消运行不会自动更改任务状态
            </p>
            {!detail.runs.length && <p>尚无运行记录。请确认任务已分配给可用的服务器执行者</p>}
            {detail.runs.map((run) => (
              <article
                key={run.id}
                className="space-y-2 rounded-xl border border-card-border bg-card p-3"
              >
                <div className="flex flex-wrap justify-between gap-2">
                  <strong className="font-medium">
                    {run.agentName || "服务器执行者"} · {paperclipLabel(run.status)}
                  </strong>
                  <span className="text-ui-sm">
                    {run.startedAt ? new Date(run.startedAt).toLocaleString("zh-CN") : "等待启动"}
                  </span>
                </div>
                <div className="break-all font-mono text-ui-sm text-foreground-subtle">
                  {run.id}
                </div>
                <div className="flex gap-2">
                  <Button variant="outline" size="sm" onClick={() => onLog(run.id)}>
                    读取日志
                  </Button>
                  {["queued", "running"].includes(run.status) && (
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={locked}
                      onClick={() =>
                        setConfirmation({ kind: "cancel", issueId: detail.issue.id, runId: run.id })
                      }
                    >
                      取消运行
                    </Button>
                  )}
                </div>
              </article>
            ))}
            {log && (
              <section className="space-y-2" aria-label="运行日志">
                <div className="flex items-center justify-between">
                  <h3 className="font-medium">运行日志</h3>
                  <Button variant="outline" onClick={() => onLog(log.runId)}>
                    继续读取
                  </Button>
                </div>
                <p className="text-ui-sm text-foreground-subtle">
                  显示原始执行输出，最多保留最近 100 万字符
                </p>
                <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-all rounded-xl bg-surface p-3 font-mono text-ui-sm">
                  {log.content || "暂时没有日志输出"}
                </pre>
              </section>
            )}
          </div>
        )}
        {tab === "approvals" && (
          <div className="space-y-3">
            <p className="text-ui-sm text-foreground-subtle">
              以下是此任务关联的服务器审批。批准前请核对完整请求内容
            </p>
            {!detail.approvals.length && <p>此任务没有关联审批</p>}
            {detail.approvals.map((approval) => (
              <article
                key={approval.id}
                className="space-y-3 rounded-xl border border-card-border bg-card p-4"
              >
                <h3 className="font-medium">
                  {paperclipLabel(approval.type)} · {paperclipLabel(approval.status)}
                </h3>
                <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-surface p-3 font-mono text-ui-sm">
                  {JSON.stringify(approval.payload, null, 2)}
                </pre>
                {approval.decisionNote && <p>处理说明：{approval.decisionNote}</p>}
                {approval.status === "pending" && (
                  <div className="flex gap-2">
                    <Button
                      disabled={locked}
                      onClick={() => {
                        setNote("");
                        setConfirmation({
                          kind: "approve",
                          issueId: detail.issue.id,
                          approvalId: approval.id,
                          expectedApproval: paperclipApprovalFingerprint(approval),
                          decisionNote: "",
                        });
                      }}
                    >
                      批准请求
                    </Button>
                    <Button
                      variant="outline"
                      disabled={locked}
                      onClick={() => {
                        setNote("");
                        setConfirmation({
                          kind: "reject",
                          issueId: detail.issue.id,
                          approvalId: approval.id,
                          expectedApproval: paperclipApprovalFingerprint(approval),
                          decisionNote: "",
                        });
                      }}
                    >
                      拒绝请求
                    </Button>
                  </div>
                )}
              </article>
            ))}
          </div>
        )}
        {tab === "artifacts" && (
          <div className="space-y-4">
            <h3 className="font-medium">任务文档</h3>
            {!detail.documents.length && <p className="text-foreground-subtle">暂无文档</p>}
            {detail.documents.map((doc) => (
              <div
                key={doc.id}
                className="flex justify-between gap-2 rounded-xl border border-border p-3"
              >
                <span>{doc.title || doc.key}</span>
                <Button
                  variant="outline"
                  onClick={() =>
                    void onDocument(doc.key).then((body) => {
                      if (body !== null) setDocument({ title: doc.title || doc.key, body });
                    })
                  }
                >
                  阅读文档
                </Button>
              </div>
            ))}
            {document && (
              <article className="rounded-xl bg-surface p-4">
                <div className="mb-3 flex justify-between">
                  <h4 className="font-medium">{document.title}</h4>
                  <Button variant="ghost" onClick={() => setDocument(null)}>
                    关闭文档
                  </Button>
                </div>
                <div className="whitespace-pre-wrap break-words">
                  {document.body || "此文档暂时为空"}
                </div>
              </article>
            )}
            <h3 className="font-medium">文件附件</h3>
            {!detail.attachments.length && <p className="text-foreground-subtle">暂无附件</p>}
            {detail.attachments.map((a) => (
              <div
                key={a.id}
                className="flex justify-between gap-2 rounded-xl border border-border p-3"
              >
                <span className="break-all">
                  {a.originalFilename || "任务附件"}
                  {a.byteSize ? ` · ${Math.ceil(a.byteSize / 1024)} KB` : ""}
                </span>
                <Button variant="outline" onClick={() => onDownload(a.id)}>
                  下载附件
                </Button>
              </div>
            ))}
            <h3 className="font-medium">其他成果</h3>
            {!detail.products.length && <p className="text-foreground-subtle">暂无其他成果</p>}
            {detail.products.map((p) => (
              <article key={p.id} className="space-y-2 rounded-xl border border-border p-3">
                <h4 className="font-medium">{p.title}</h4>
                <p className="text-ui-sm">
                  {paperclipLabel(p.type)} · {paperclipLabel(p.status)}
                </p>
                {p.summary && <p className="whitespace-pre-wrap">{p.summary}</p>}
                {p.url && <p className="break-all font-mono text-ui-sm">{p.url}</p>}
              </article>
            ))}
          </div>
        )}
      </div>
      {confirmation && (
        <div
          className="absolute inset-0 z-50 flex items-center justify-center bg-background/90 p-4"
          role="dialog"
          aria-modal="true"
          aria-labelledby="paperclip-confirm-title"
        >
          <section className="w-full max-w-lg space-y-4 rounded-2xl border border-popover-border bg-popover p-6 shadow-lg">
            <h3 id="paperclip-confirm-title" className="text-ui-lg font-medium">
              {confirmation.kind === "cancel"
                ? "确认取消这次运行？"
                : confirmation.kind === "status"
                  ? `确认改为“${paperclipLabel(confirmation.status)}”？`
                  : confirmation.kind === "approve"
                    ? "确认批准此请求？"
                    : "确认拒绝此请求？"}
            </h3>
            <p>此操作会提交到当前任务所属的服务器和公司。请核对任务“{detail.issue.title}”</p>
            {(confirmation.kind === "approve" || confirmation.kind === "reject") && (
              <label className="block space-y-2">
                处理说明
                <Textarea
                  aria-label="审批处理说明"
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  maxLength={4000}
                />
              </label>
            )}
            <div className="flex justify-end gap-2">
              <Button variant="outline" disabled={submitting} onClick={() => setConfirmation(null)}>
                返回
              </Button>
              <Button
                disabled={locked}
                onClick={() => {
                  const command =
                    confirmation.kind === "approve" || confirmation.kind === "reject"
                      ? { ...confirmation, decisionNote: note }
                      : confirmation;
                  void send(command).then((ok) => {
                    if (ok) setConfirmation(null);
                  });
                }}
              >
                {submitting ? "提交中…" : "确认提交"}
              </Button>
            </div>
          </section>
        </div>
      )}
    </section>
  );
}
