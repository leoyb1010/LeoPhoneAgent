// [leo] 随包 Peekaboo（MCP 服务 `leo-screen`，见 desktop host registerPeekabooMcp.ts）的写操作审批分类。
//
// 规则（docs/specs/leo-screen-write-approval.md）：
// - 只按真实 MCP 身份（descriptor.serverName + descriptor.toolName）和本次入参的 action 判定，
//   不看模型可见名、UI 别名或工具描述。
// - 观察类（截图、看屏、读界面树、权限查询、等待、状态校验）保持免确认。
// - 带 action 的混合工具只有明确的只读 action 免确认；缺省或未知 action 一律当写操作。
// - 不在下表里的工具（含 Peekaboo 以后新增的工具）默认当写操作，要求明确审批。
//
// 表内名称取自 Peekaboo 4.9.4 的 MCP 工具目录（scripts/leo-fetch-peekaboo.mjs 钉的版本；
// 上游 docs/MCP.md、docs/commands/tools.md）。升级 Peekaboo 时复核这张表。

export const LEO_SCREEN_MCP_SERVER_NAME = "leo-screen";
export const LEO_SCREEN_WRITE_APPROVAL_RULE = "leo.screen.write";

/** 纯观察工具：不改变任何应用、窗口、输入焦点或剪贴板状态。 */
const LEO_SCREEN_OBSERVATION_TOOLS: ReadonlySet<string> = new Set([
  "image",
  "see",
  "inspect_ui",
  "analyze",
  "permissions",
  "sleep",
  "verify_state",
  "list",
]);

/** 混合工具里只读的 action；其余 action（launch / quit / focus / click / set / switch 等）都是写操作。 */
const LEO_SCREEN_READ_ONLY_ACTIONS: Readonly<Record<string, ReadonlySet<string>>> = {
  app: new Set(["list"]),
  window: new Set(["list"]),
  menu: new Set(["list"]),
  menubar: new Set(["list"]),
  dock: new Set(["list"]),
  space: new Set(["list"]),
  // save 会把剪贴板写到文件；get 带 outputPath 同样写文件（Peekaboo v4.9.4 ClipboardTool.swift 149-153），
  // 只有不带 outputPath 的 get 是纯读取，见 hasOutputPath。
  clipboard: new Set(["get"]),
};

export function isLeoScreenMcpServer(serverName: string): boolean {
  return serverName.trim().toLowerCase() === LEO_SCREEN_MCP_SERVER_NAME;
}

function hasOutputPath(input: unknown): boolean {
  if (!input || typeof input !== "object") return false;
  const record = input as Record<string, unknown>;
  // 只要给了输出路径（任何非 undefined/null 的值）就当写文件，空串也不放过，交给工具自己报错。
  return [record.outputPath, record.output_path].some((value) => value !== undefined && value !== null);
}

function readAction(input: unknown): string | undefined {
  if (!input || typeof input !== "object") return undefined;
  const action = (input as Record<string, unknown>).action;
  return typeof action === "string" && action.trim() ? action.trim().toLowerCase() : undefined;
}

/** leo-screen 工具的这次调用是否会改变桌面状态（点击、输入、启动 / 退出应用、移动窗口等）。 */
export function isLeoScreenWriteCall(toolName: string, input: unknown): boolean {
  const name = toolName.trim().toLowerCase();
  if (LEO_SCREEN_OBSERVATION_TOOLS.has(name)) return false;
  const readOnlyActions = LEO_SCREEN_READ_ONLY_ACTIONS[name];
  if (readOnlyActions) {
    const action = readAction(input);
    if (action === undefined || !readOnlyActions.has(action)) return true;
    return name === "clipboard" && hasOutputPath(input);
  }
  return true;
}
