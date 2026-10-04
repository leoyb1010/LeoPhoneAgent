import { useState } from "react";
import type { PaperclipReceipt } from "@zcode/services/paperclip";
import { Button } from "../components/ui/button.js";
export function PaperclipReceiptBanner({
  receipt,
  busy,
  onReconcile,
  onAcknowledge,
}: {
  receipt: PaperclipReceipt;
  busy: boolean;
  onReconcile: () => void;
  onAcknowledge: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  return (
    <>
      <div
        className="flex flex-wrap items-center justify-between gap-2 border-b border-border bg-surface p-3"
        role="status"
      >
        <span>
          有一项操作等待服务器确认，已暂停新的提交。回执：
          <span className="font-mono text-ui-sm">{receipt.id}</span>
        </span>
        <div className="flex gap-2">
          <Button disabled={busy} onClick={onReconcile}>
            {busy ? "核实中…" : "核实结果"}
          </Button>
          <Button variant="outline" disabled={busy} onClick={() => setConfirming(true)}>
            已人工核实
          </Button>
        </div>
      </div>
      {confirming && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="paperclip-receipt-title"
          className="absolute inset-0 z-50 flex items-center justify-center bg-background/90 p-4"
        >
          <section className="w-full max-w-xl space-y-4 rounded-2xl border border-popover-border bg-popover p-6 shadow-lg">
            <h2 id="paperclip-receipt-title" className="text-ui-lg font-medium">
              确认已人工核实原操作？
            </h2>
            <p>
              这项操作可能已经在服务器生效。请先核对任务、回复或审批结果，确认不会因新提交而重复执行。此操作只解除本机阻塞，不会再次发送原请求；原回执会保留
            </p>
            <p className="break-all text-ui-sm">
              服务器：{receipt.binding.serverUrl}
              <br />
              组织：{receipt.binding.companyId}
              <br />
              回执：{receipt.id}
              <br />
              提交时间：{receipt.createdAt}
            </p>
            <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-surface p-3 font-mono text-ui-sm">
              {receipt.command.kind === "create"
                ? `${receipt.command.title}\n${receipt.command.description}`
                : receipt.command.kind === "reply"
                  ? receipt.command.body
                  : `任务：${receipt.command.issueId}`}
            </pre>
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setConfirming(false)}>
                继续保留待核实
              </Button>
              <Button
                disabled={busy}
                onClick={() => {
                  onAcknowledge();
                  setConfirming(false);
                }}
              >
                确认已核对，解除阻塞
              </Button>
            </div>
          </section>
        </div>
      )}
    </>
  );
}
