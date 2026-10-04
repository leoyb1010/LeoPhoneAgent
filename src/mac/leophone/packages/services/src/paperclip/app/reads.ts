import type { NativePaperclipPort } from "@zcode/shared";
import type { PaperclipDetail, PaperclipSnapshot } from "../contract.js";
import { paperclipId } from "../domain/identity.js";
import {
  logSchema,
  issueSchema,
  commentSchema,
  runSchema,
  approvalSchema,
  attachmentSchema,
  agentSchema,
} from "./responses.js";

export async function readBoundWorkspace(
  api: (path: string) => Promise<unknown>,
  companyId: string,
  loadedCount: number,
  loadMore: boolean,
) {
  const root = `/api/companies/${paperclipId(companyId)}`;
  let consumed = loadMore ? loadedCount : 0;
  const rows = [];
  let hasMore = false;
  do {
    const page = issueSchema
      .array()
      .parse(await api(`${root}/issues?limit=100&offset=${consumed}`));
    rows.push(...page);
    consumed += page.length;
    hasMore = page.length === 100;
    if (!hasMore || loadMore) break;
  } while (consumed < loadedCount);
  const agents = agentSchema.array().parse(await api(`${root}/agents`));
  if (
    rows.some((row) => row.companyId !== companyId) ||
    agents.some((row) => row.companyId !== companyId)
  )
    throw new Error("服务器返回了其他公司的数据，已阻止。");
  return { rows, agents, consumed, hasMore };
}

export async function readBoundDetail(
  api: (path: string) => Promise<unknown>,
  companyId: string,
  issueId: string,
): Promise<PaperclipDetail> {
  const path = `/api/issues/${paperclipId(issueId)}`;
  const [rawIssue, rawComments, rawRuns, rawApprovals, rawAttachments] = await Promise.all(
    ["", "/comments?order=asc", "/runs", "/approvals", "/attachments"].map((suffix) =>
      api(path + suffix),
    ),
  );
  const detail = {
    issue: issueSchema.parse(rawIssue),
    comments: commentSchema.array().parse(rawComments),
    runs: runSchema.array().parse(rawRuns),
    approvals: approvalSchema.array().parse(rawApprovals),
    attachments: attachmentSchema.array().parse(rawAttachments),
  };
  if (
    detail.issue.id !== issueId ||
    detail.issue.companyId !== companyId ||
    [...detail.comments, ...detail.attachments].some(
      (row) => row.companyId !== companyId || row.issueId !== issueId,
    ) ||
    detail.approvals.some((row) => row.companyId !== companyId)
  )
    throw new Error("任务归属与当前公司不一致，已阻止。");
  return detail;
}

export async function readBoundLog(
  api: (path: string) => Promise<unknown>,
  detail: PaperclipDetail,
  runId: string,
  previous: PaperclipSnapshot["log"],
): Promise<NonNullable<PaperclipSnapshot["log"]>> {
  if (!detail.runs.some((run) => run.runId === runId)) throw new Error("运行不属于当前任务。");
  const offset = previous?.runId === runId ? previous.nextOffset : 0;
  const log = logSchema.parse(
    await api(`/api/heartbeat-runs/${paperclipId(runId)}/log?offset=${offset}&limitBytes=64000`),
  );
  if (log.runId !== runId || log.nextOffset < offset || (log.content && log.nextOffset === offset))
    throw new Error("日志归属或读取位置不兼容，已阻止拼接。");
  return {
    ...log,
    content: ((previous?.runId === runId ? previous.content : "") + log.content).slice(-1000000),
  };
}

export async function downloadBoundAttachment(
  port: NativePaperclipPort,
  detail: PaperclipDetail,
  attachmentId: string,
  serverUrl: string,
  expectedUserId: string,
): Promise<void> {
  const attachment = detail.attachments.find((item) => item.id === attachmentId);
  if (!attachment) throw new Error("附件不属于当前任务。");
  const permitted = [
    `/api/attachments/${paperclipId(attachment.id)}/content`,
    `/api/assets/${paperclipId(attachment.assetId)}/content`,
  ];
  if (!permitted.includes(attachment.contentPath)) throw new Error("附件下载路径不兼容，已阻止。");
  await port.download({
    serverUrl,
    path: attachment.contentPath,
    expectedUserId,
    filename: attachment.originalFilename ?? "Paperclip-附件",
  });
}
