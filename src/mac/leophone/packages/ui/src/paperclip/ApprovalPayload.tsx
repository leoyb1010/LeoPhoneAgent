// 审批内容原来直接显示 JSON；改为「字段 · 值」列表，原始 JSON 收进「展开原始内容」，核对时仍可看全量。
const FIELD_LABELS: Record<string, string> = {
  name: "名称",
  title: "标题",
  role: "角色",
  adapter: "运行方式",
  adapterType: "运行方式",
  model: "模型",
  plan: "计划",
  reason: "原因",
  description: "说明",
  budgetMonthlyCents: "每月预算（分）",
};

function formatValue(value: unknown): string {
  if (value === null || value === undefined || value === "") return "—";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

export function PaperclipApprovalPayload({
  payload,
  raw,
}: {
  payload: Record<string, unknown>;
  /** 原始内容；不传时用 payload 本身。 */
  raw?: unknown;
}) {
  const entries = Object.entries(payload);
  return (
    <div className="space-y-2 text-ui-caption">
      {entries.length === 0 ? (
        <p className="text-foreground-subtle">服务器没有附带审批内容。</p>
      ) : (
        <dl className="grid grid-cols-[minmax(0,auto)_minmax(0,1fr)] gap-x-3 gap-y-1.5">
          {entries.map(([key, value]) => (
            <div key={key} className="contents">
              <dt className="text-foreground-subtle">{FIELD_LABELS[key] ?? key}</dt>
              <dd className="min-w-0 whitespace-pre-wrap break-words">{formatValue(value)}</dd>
            </div>
          ))}
        </dl>
      )}
      <details>
        <summary className="cursor-pointer text-foreground-subtle">展开原始内容</summary>
        <pre className="mt-2 max-h-56 overflow-auto whitespace-pre-wrap break-words rounded-md bg-surface p-3">
          {JSON.stringify(raw ?? payload, null, 2)}
        </pre>
      </details>
    </div>
  );
}
