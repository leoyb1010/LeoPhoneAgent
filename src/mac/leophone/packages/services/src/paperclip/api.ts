import type {
  PaperclipBinding,
  PaperclipComment,
  PaperclipDetail,
  PaperclipIssue,
  PaperclipReceipt,
  PaperclipRun,
  PaperclipTransport,
} from "./contract.js";
import {
  paperclipApprovalFingerprint,
  object,
  PaperclipFailure,
  request,
  rows,
  string,
} from "./protocol.js";
const id = encodeURIComponent;
export async function readDetail(
  transport: PaperclipTransport,
  binding: PaperclipBinding,
  issueId: string,
): Promise<PaperclipDetail> {
  const get = (suffix: string) =>
    request(transport, binding.serverUrl, "GET", `/issues/${id(issueId)}${suffix}`);
  const values = await Promise.all(
    [
      "",
      "/comments?order=desc&limit=100",
      "/runs",
      "/live-runs",
      "/approvals",
      "/documents",
      "/attachments",
      "/work-products",
    ].map(get),
  );
  const issue = rows<PaperclipIssue>(
    [values[0]],
    ["id", "companyId", "title", "status"],
    binding,
  )[0]!;
  if (issue.id !== issueId) throw new PaperclipFailure(-1);
  const historical = rows<Record<string, unknown>>(values[2], ["runId", "agentId", "status"]).map(
    (run) => ({ ...run, id: string(run.runId) }) as unknown as PaperclipRun,
  );
  const live = rows<PaperclipRun>(values[3], ["id", "agentId", "status"]);
  return {
    issue,
    comments: rows<PaperclipComment>(
      values[1],
      ["id", "issueId", "companyId"],
      binding,
      issueId,
    ).reverse(),
    runs: [...new Map([...historical, ...live].map((run) => [run.id, run])).values()],
    approvals: rows(values[4], ["id", "companyId", "type", "status"], binding),
    documents: rows(values[5], ["id", "companyId", "issueId", "key"], binding, issueId),
    attachments: rows(values[6], ["id", "companyId", "issueId"], binding, issueId),
    products: rows(
      values[7],
      ["id", "companyId", "issueId", "title", "type", "status"],
      binding,
      issueId,
    ),
  };
}
/** 上游只有创建/评论承诺幂等；其他命令必须读回核实，不能盲重试。 */
export async function sendMutation(
  transport: PaperclipTransport,
  receipt: PaperclipReceipt,
): Promise<string | null> {
  const { command: c, binding: b } = receipt;
  let path: string;
  let body: unknown;
  let method: "POST" | "PATCH" = "POST";
  if (c.kind === "create") {
    path = `/companies/${id(b.companyId)}/issues`;
    body = {
      title: c.title,
      description: c.description,
      assigneeAgentId: c.agentId,
      status: "todo",
      idempotencyKey: receipt.id,
    };
  } else if (c.kind === "reply") {
    path = `/issues/${id(c.issueId)}/comments`;
    body = { body: c.body, clientRequestId: receipt.id };
  } else if (c.kind === "status") {
    path = `/issues/${id(c.issueId)}`;
    method = "PATCH";
    body = { status: c.status };
  } else if (c.kind === "cancel") {
    path = `/heartbeat-runs/${id(c.runId)}/cancel`;
    body = {};
  } else {
    // 提交前重新读取用户确认过的完整请求；上游无原子版本条件，剩余竞态需服务端治理。
    const latest = await request(transport, b.serverUrl, "GET", `/approvals/${id(c.approvalId)}`);
    if (!c.expectedApproval || paperclipApprovalFingerprint(latest) !== c.expectedApproval)
      throw new PaperclipFailure(422, "审批内容已变化，请刷新后重新核对完整请求");
    path = `/approvals/${id(c.approvalId)}/${c.kind}`;
    body = { decisionNote: c.decisionNote };
  }
  const response = await request(transport, b.serverUrl, method, path, body, b.userId);
  if (c.kind === "cancel") return null; // 取消接口允许空回执，完成后必须通过 GET 再核实。
  const value = object(response);
  if (c.kind === "reply") {
    if (value.issueId !== c.issueId || value.companyId !== b.companyId || value.body !== c.body)
      throw new PaperclipFailure(-1);
    string(value.id);
  } else if (c.kind === "create") {
    if (value.companyId !== b.companyId) throw new PaperclipFailure(-1);
    return string(value.id);
  } else if (c.kind === "status") {
    if (value.id !== c.issueId || value.companyId !== b.companyId || value.status !== c.status)
      throw new PaperclipFailure(-1);
  } else if (
    value.id !== c.approvalId ||
    value.companyId !== b.companyId ||
    value.status !== (c.kind === "approve" ? "approved" : "rejected")
  ) {
    throw new PaperclipFailure(-1);
  }
  return null;
}
export async function reconcileMutation(
  transport: PaperclipTransport,
  receipt: PaperclipReceipt,
): Promise<string | null> {
  const { command: c, binding: b } = receipt;
  // 上游 create 的幂等记录仅保留七天；六天后禁止重放，防止失联旧任务被再次创建。
  const age = Date.now() - Date.parse(receipt.createdAt);
  if (!Number.isFinite(age) || age < 0 || (c.kind === "create" && age >= 6 * 24 * 60 * 60 * 1000)) {
    throw new PaperclipFailure(
      -1,
      "这项创建操作已超过安全核实期限，请在服务器任务列表中人工确认。不会重新发送，以免创建重复任务",
    );
  }
  if (c.kind === "create" || c.kind === "reply") return sendMutation(transport, receipt);
  const path =
    c.kind === "status"
      ? `/issues/${id(c.issueId)}`
      : c.kind === "cancel"
        ? `/heartbeat-runs/${id(c.runId)}`
        : `/approvals/${id(c.approvalId)}`;
  const value = object(await request(transport, b.serverUrl, "GET", path));
  const expectedId = c.kind === "status" ? c.issueId : c.kind === "cancel" ? c.runId : c.approvalId;
  if (value.companyId !== b.companyId || value.id !== expectedId) throw new PaperclipFailure(-1);
  const confirmed =
    c.kind === "status"
      ? value.status === c.status
      : c.kind === "cancel"
        ? ["cancelled", "succeeded", "failed", "timed_out"].includes(String(value.status))
        : value.status === (c.kind === "approve" ? "approved" : "rejected");
  if (!confirmed)
    throw new PaperclipFailure(-1, "服务器尚未确认此操作，请稍后再次核实；不会重复发送");
  return null;
}
