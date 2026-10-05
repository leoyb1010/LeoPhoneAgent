import {
  paperclipApprovalFingerprint,
  type IPaperclipWorkspace,
  type PaperclipCommand,
  type PaperclipSnapshot,
} from "@zcode/services";
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import { PAPERCLIP_ISSUE_STATUSES } from "@zcode/shared";
import { paperclipPriority, paperclipStatus } from "./labels.js";
export type PaperclipDecision = { title: string; command: PaperclipCommand; preview?: string };
export function PaperclipInspector({
  service,
  snapshot,
  invoke,
  setDecision,
  notes,
  setNote,
}: {
  service: IPaperclipWorkspace;
  snapshot: PaperclipSnapshot;
  invoke: (action: () => Promise<void>) => Promise<boolean>;
  setDecision: (decision: PaperclipDecision) => void;
  /** 审批决定说明按审批 id 分开保存，避免一条审批的说明串到另一条。 */
  notes: Record<string, string>;
  setNote: (approvalId: string, note: string) => void;
}) {
  const detail = snapshot.detail!;
  const assignee = snapshot.agents.find((agent) => agent.id === detail.issue.assigneeAgentId);
  return (
    <div className="space-y-5 text-ui-caption">
      {Object.values(snapshot.receipts)
        .filter(
          (row) =>
            row.state === "unknown" &&
            row.targetId === detail.issue.id &&
            ["status", "approval", "cancel"].includes(row.kind ?? ""),
        )
        .map((receipt) => (
          <section key={receipt.id} className="space-y-2">
            <p>原操作结果待核实。核实只读取服务器，不会再次提交。</p>
            {receipt.unblockAction && <p>原解除条件：{receipt.unblockAction}</p>}
            <Button
              variant="outline"
              disabled={snapshot.busy || snapshot.ready === false}
              onClick={() =>
                void invoke(() => service.command({ kind: "reconcile", receiptId: receipt.id }))
              }
            >
              核实原操作
            </Button>
          </section>
        ))}
      <section className="space-y-4">
        <h3 className="text-ui-base font-medium">任务属性</h3>
        <label className="flex flex-col gap-2">
          <span className="text-foreground-subtle">状态</span>
          <select
            aria-label="更改任务状态"
            className="pc-select text-ui-caption"
            value={detail.issue.status}
            disabled={snapshot.busy || snapshot.ready === false}
            onChange={(event) =>
              setDecision({
                title: `将任务设为「${paperclipStatus(event.target.value)}」？`,
                command: { kind: "status", issueId: detail.issue.id, status: event.target.value },
              })
            }
          >
            {PAPERCLIP_ISSUE_STATUSES.map((status) => (
              <option key={status} value={status}>
                {paperclipStatus(status)}
              </option>
            ))}
          </select>
        </label>
        <div className="flex items-center gap-3">
          <span className="w-16 shrink-0 text-foreground-subtle">执行者</span>
          <span className="min-w-0 break-words">
            {assignee?.name || (detail.issue.assigneeAgentId ? "服务器代理" : "暂未分配")}
          </span>
        </div>
        <div className="flex items-center gap-3">
          <span className="w-16 shrink-0 text-foreground-subtle">优先级</span>
          <span>{paperclipPriority(detail.issue.priority)}</span>
        </div>
        <div className="flex items-center gap-3">
          <span className="w-16 shrink-0 text-foreground-subtle">任务编号</span>
          <span className="min-w-0 break-all font-mono text-ui-sm">
            {detail.issue.identifier || detail.issue.id}
          </span>
        </div>
      </section>
      <section className="flex flex-col gap-3 border-t border-border pt-4">
        <h3 className="text-ui-base font-medium">关联审批</h3>
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
            <p className="mb-3 text-ui-caption">
              申请者：{approval.requestedByUserId ?? approval.requestedByAgentId ?? "服务器未提供"}
            </p>
            {approval.decisionNote && <p className="mb-3">决定说明：{approval.decisionNote}</p>}
            {approval.status === "pending" && (
              <div className="flex flex-col gap-2">
                <Input
                  aria-label="决定说明"
                  placeholder="决定说明（可选）"
                  value={notes[approval.id] ?? ""}
                  disabled={snapshot.busy || snapshot.ready === false}
                  onChange={(event) => setNote(approval.id, event.target.value)}
                />
                <div className="flex gap-2">
                  {[true, false].map((approve) => (
                    <Button
                      key={String(approve)}
                      variant={approve ? "default" : "outline"}
                      disabled={snapshot.busy || snapshot.ready === false}
                      onClick={() =>
                        setDecision({
                          title: approve ? "确认批准此请求？" : "确认拒绝此请求？",
                          preview: JSON.stringify(approval, null, 2),
                          command: {
                            kind: "approval",
                            issueId: detail.issue.id,
                            approvalId: approval.id,
                            approve,
                            note: notes[approval.id] ?? "",
                            expectedApproval: paperclipApprovalFingerprint(approval),
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
        <h3 className="text-ui-base font-medium">运行记录</h3>
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
              disabled={snapshot.busy || snapshot.ready === false}
              onClick={() => void invoke(() => service.readLog(run.runId))}
            >
              {snapshot.log?.runId === run.runId ? "继续读取日志" : "读取日志"}
            </Button>
            {["queued", "running"].includes(run.status) && (
              <Button
                variant="outline"
                disabled={snapshot.busy || snapshot.ready === false}
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
              每次继续读取最多 64 KB，保留最近 1 MB。原始输出可能包含英文。
            </p>
            <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-words rounded-md bg-surface p-3 text-ui-caption">
              {snapshot.log.content || "暂无日志内容"}
            </pre>
          </div>
        )}
      </section>
      <section className="flex flex-col gap-3 border-t border-border pt-4">
        <h3 className="text-ui-base font-medium">服务器附件</h3>
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
              disabled={snapshot.busy || snapshot.ready === false}
              onClick={() => void invoke(() => service.downloadAttachment(attachment.id))}
            >
              下载附件
            </Button>
          </div>
        ))}
      </section>
    </div>
  );
}
