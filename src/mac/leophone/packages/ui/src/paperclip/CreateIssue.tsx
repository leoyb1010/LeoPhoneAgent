import type { IPaperclipWorkspace, PaperclipSnapshot } from "@zcode/services";
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import { Textarea } from "@/components/ui/textarea.js";
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
  const send = async () => {
    if (!creationRetryAllowed) return;
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
    <section className="mx-auto flex w-full max-w-3xl flex-col gap-4 p-5 text-ui-base">
      <h2 className="text-ui-xl font-semibold">新建服务器任务</h2>
      <p className="text-ui-caption text-foreground-subtle">
        提交到当前公司。指定代理后，服务器按自己的调度与审批规则执行。
      </p>
      <label className="flex flex-col gap-2">
        任务标题
        <Input
          value={draft.title}
          disabled={snapshot.busy || draft.submitted}
          onChange={(event) => update({ title: event.target.value })}
        />
      </label>
      <label className="flex flex-col gap-2">
        说明与验收条件
        <Textarea
          rows={7}
          value={draft.body}
          disabled={snapshot.busy || draft.submitted}
          onChange={(event) => update({ body: event.target.value })}
        />
      </label>
      <label className="flex flex-col gap-2">
        执行代理
        <select
          className="rounded-md border border-input-border bg-input p-2 text-ui-base"
          value={draft.agentId}
          disabled={snapshot.busy || draft.submitted}
          onChange={(event) => update({ agentId: event.target.value })}
        >
          <option value="">暂不分配（待规划）</option>
          {snapshot.agents
            .filter((agent) => agent.status !== "terminated")
            .map((agent) => (
              <option key={agent.id} value={agent.id}>
                {agent.name}
              </option>
            ))}
        </select>
      </label>
      {draft.submitted && (
        <p role="status" className="text-ui-caption text-warning">
          {creationRetryAllowed
            ? "提交结果需核对。创建去重键只保留 7 天，期限内手动重试使用原请求编号。"
            : "已超出去重期限或缺少可信提交时间，不能重发。草稿内容已保留，请先核对服务器列表。"}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <Button
          onClick={() => void send()}
          disabled={snapshot.busy || !creationRetryAllowed || !draft.title.trim()}
        >
          {draft.submitted ? "重试同一创建" : "创建任务"}
        </Button>
        <Button variant="outline" onClick={onClose} disabled={snapshot.busy}>
          关闭并保留草稿
        </Button>
        {draft.submitted && (
          <Button variant="outline" onClick={clear} disabled={snapshot.busy}>
            已核对，放弃草稿
          </Button>
        )}
      </div>
    </section>
  );
}
