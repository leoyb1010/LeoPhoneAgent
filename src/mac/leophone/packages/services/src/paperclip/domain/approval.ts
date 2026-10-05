// domain 不引用 contract：contract 公开导出本函数，反向类型引用会形成模块内循环依赖。
// 结构与 contract 中的 PaperclipApproval 兼容（只列出参与指纹的字段）。
interface ApprovalFingerprintInput {
  id: string;
  companyId: string;
  type: string;
  status: string;
  payload: Record<string, unknown>;
  requestedByAgentId?: string | null;
  requestedByUserId?: string | null;
}

/** 对申请内容和申请者做稳定比较；字段顺序不应改变用户已确认的含义。 */
export function paperclipApprovalFingerprint(approval: ApprovalFingerprintInput): string {
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
