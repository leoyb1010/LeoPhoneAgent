import type { PaperclipApproval } from "../contract.js";

/** 对申请内容和申请者做稳定比较；字段顺序不应改变用户已确认的含义。 */
export function paperclipApprovalFingerprint(approval: PaperclipApproval): string {
  const normalize = (value: unknown): unknown =>
    Array.isArray(value)
      ? value.map(normalize)
      : value !== null && typeof value === "object"
        ? Object.fromEntries(
            Object.entries(value)
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([key, entry]) => [key, normalize(entry)]),
          )
        : value;
  return JSON.stringify(
    normalize({
      id: approval.id,
      companyId: approval.companyId,
      type: approval.type,
      status: approval.status,
      payload: approval.payload,
      requestedByAgentId: approval.requestedByAgentId ?? null,
      requestedByUserId: approval.requestedByUserId ?? null,
    }),
  );
}
