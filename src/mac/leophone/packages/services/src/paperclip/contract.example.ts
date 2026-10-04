import {
  PaperclipWorkspaceService,
  type PaperclipPersistence,
  type PaperclipTransport,
} from "./contract.js";
/** 平台注入；不会把服务端故障转换成本地执行。 */
export function createPaperclipWorkspaceExample(
  transport: PaperclipTransport,
  persistence: PaperclipPersistence,
) {
  const workspace = new PaperclipWorkspaceService(transport, persistence);
  return { workspace, connect: () => workspace.refresh() };
}
