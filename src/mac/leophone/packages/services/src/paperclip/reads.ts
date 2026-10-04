import type {
  PaperclipAttachment,
  PaperclipBinding,
  PaperclipSnapshot,
  PaperclipTransport,
} from "./contract.js";
import { object, PaperclipFailure, request } from "./protocol.js";
export async function readBoundLog(
  transport: PaperclipTransport,
  binding: PaperclipBinding,
  runId: string,
  previous: PaperclipSnapshot["log"],
): Promise<PaperclipSnapshot["log"]> {
  const offset = previous?.nextOffset ?? 0;
  const data = object(
    await request(
      transport,
      binding.serverUrl,
      "GET",
      `/heartbeat-runs/${encodeURIComponent(runId)}/log?offset=${offset}&limitBytes=256000`,
    ),
  );
  if (
    data.runId !== runId ||
    typeof data.content !== "string" ||
    (data.nextOffset !== undefined &&
      (!Number.isSafeInteger(data.nextOffset) || Number(data.nextOffset) < offset))
  )
    throw new PaperclipFailure(-1);
  // 非空日志缺少游标不能安全增量重放，拒绝而不是重新拼接同一段日志。
  if (data.content && typeof data.nextOffset !== "number")
    throw new PaperclipFailure(-1, "日志缺少读取位置，请检查服务器版本");
  return {
    runId,
    content: ((previous?.content ?? "") + data.content).slice(-1000000),
    nextOffset: typeof data.nextOffset === "number" ? data.nextOffset : offset,
  };
}
export async function readBoundDocument(
  transport: PaperclipTransport,
  binding: PaperclipBinding,
  issueId: string,
  key: string,
): Promise<string> {
  const data = object(
    await request(
      transport,
      binding.serverUrl,
      "GET",
      `/issues/${encodeURIComponent(issueId)}/documents/${encodeURIComponent(key)}`,
    ),
  );
  if (
    data.companyId !== binding.companyId ||
    data.issueId !== issueId ||
    data.key !== key ||
    typeof data.body !== "string"
  )
    throw new PaperclipFailure(-1);
  return data.body;
}

export async function downloadBoundAttachment(
  transport: PaperclipTransport,
  binding: PaperclipBinding,
  attachment: PaperclipAttachment,
): Promise<void> {
  if (!transport.download) throw new Error("当前客户端不支持下载，请更新桌面应用");
  await transport.download({
    serverUrl: binding.serverUrl,
    path: `/api/attachments/${encodeURIComponent(attachment.id)}/content?download=1`,
    filename: attachment.originalFilename || "任务附件",
  });
}
