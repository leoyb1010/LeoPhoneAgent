const SORTED_PROVIDER_TOOL_NAMES = new Set([
  "Agent",
  "AskUserQuestion",
  "Bash",
  "CronCreate",
  "CronDelete",
  "CronList",
  "CronUpdate",
  "Edit",
  "EnterPlanMode",
  "EnterWorktree",
  "ExitPlanMode",
  "ExitWorktree",
  "Glob",
  "Grep",
  "LSP",
  "NotebookEdit",
  "Read",
  "ScheduleWakeup",
  "Skill",
  "TaskCreate",
  "TaskGet",
  "TaskList",
  "TaskOutput",
  "TaskStop",
  "TaskUpdate",
  "TodoRead",
  "TodoWrite",
  "WebFetch",
  "WebSearch",
  "Workflow",
  "Write",
]);

export function orderProviderVisibleToolContracts<T extends { name: string }>(
  tools: readonly T[],
): T[] {
  const referenceTools: T[] = [];
  const localTools: T[] = [];
  for (const tool of tools) {
    if (SORTED_PROVIDER_TOOL_NAMES.has(tool.name)) {
      referenceTools.push(tool);
    } else {
      localTools.push(tool);
    }
  }

  // [leo] prompt cache 要求工具列表逐字节稳定：非内置工具（MCP、插件、按需注册的内置工具）按名字
  // 排序，不再取决于注册 / MCP 连上的先后；比较用码点而不是 localeCompare，不随系统 locale 变化。
  return [
    ...referenceTools.sort(compareToolNamesByCodePoint),
    ...localTools.sort(compareToolNamesByCodePoint),
  ];
}

function compareToolNamesByCodePoint(left: { name: string }, right: { name: string }): number {
  if (left.name === right.name) return 0;
  return left.name < right.name ? -1 : 1;
}
