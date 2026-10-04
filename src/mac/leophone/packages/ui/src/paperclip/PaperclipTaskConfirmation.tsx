import { useState } from "react";
import { paperclipLabel, type PaperclipCommand } from "@zcode/services/paperclip";
import { Button } from "../components/ui/button.js";
import { Textarea } from "../components/ui/textarea.js";

export function PaperclipTaskConfirmation({
  command,
  issueTitle,
  locked,
  submitting,
  onClose,
  onConfirm,
}: {
  command: PaperclipCommand;
  issueTitle: string;
  locked: boolean;
  submitting: boolean;
  onClose: () => void;
  onConfirm: (command: PaperclipCommand) => Promise<void>;
}) {
  const [note, setNote] = useState(
    command.kind === "approve" || command.kind === "reject" ? command.decisionNote : "",
  );
  const [action, setAction] = useState(
    command.kind === "status" ? (command.unblockAction ?? "") : "",
  );
  const blocked = command.kind === "status" && command.status === "blocked";
  const invalidAction = blocked && (!action.trim() || action.trim().length > 2000);
  return (
    <div
      className="absolute inset-0 z-50 flex items-center justify-center bg-background/90 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="paperclip-confirm-title"
    >
      <section className="w-full max-w-lg space-y-4 rounded-2xl border border-popover-border bg-popover p-6 shadow-lg">
        <h3 id="paperclip-confirm-title" className="text-ui-lg font-medium">
          {command.kind === "cancel"
            ? "确认取消这次运行？"
            : command.kind === "status"
              ? `确认改为“${paperclipLabel(command.status)}”？`
              : command.kind === "approve"
                ? "确认批准此请求？"
                : "确认拒绝此请求？"}
        </h3>
        <p>此操作会提交到当前任务所属的服务器和组织。请核对任务“{issueTitle}”</p>
        {blocked && (
          <div className="space-y-2">
            <label className="block space-y-2">
              解除受阻所需操作（必填）
              <Textarea
                aria-label="解除受阻所需操作"
                aria-describedby="paperclip-unblock-help"
                value={action}
                onChange={(e) => setAction(e.target.value)}
                maxLength={2000}
                required
                disabled={submitting}
                placeholder="明确写出需要你完成什么，任务才能继续…"
              />
            </label>
            <p id="paperclip-unblock-help" className="text-ui-sm text-foreground-subtle">
              解除受阻的责任人将设为当前登录账号。请填写 1–2000 个字符，不会自动补写行动内容
            </p>
          </div>
        )}
        {(command.kind === "approve" || command.kind === "reject") && (
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
          <Button variant="outline" disabled={submitting} onClick={onClose}>
            返回
          </Button>
          <Button
            disabled={locked || invalidAction}
            onClick={() => {
              if (invalidAction) return;
              const confirmed =
                command.kind === "approve" || command.kind === "reject"
                  ? { ...command, decisionNote: note }
                  : blocked && command.kind === "status"
                    ? { ...command, unblockAction: action.trim() }
                    : command;
              void onConfirm(confirmed);
            }}
          >
            {submitting ? "提交中…" : "确认提交"}
          </Button>
        </div>
      </section>
    </div>
  );
}
