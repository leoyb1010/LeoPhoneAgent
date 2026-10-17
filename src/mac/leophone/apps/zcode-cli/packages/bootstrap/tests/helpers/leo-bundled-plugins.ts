import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

// [leo] Leo 随包并默认启用 superpowers 插件（src/app/official-plugin-definitions.ts），它的
// SessionStart hook 会在每个（含工作流子）会话启动时经 ExecutionPort 执行，并注入额外的 hook
// 事件与上下文消息。只验证上游 Runtime 行为的用例用项目级配置关掉它，避免把插件 hook 混进断言。
export const SUPERPOWERS_PLUGIN_ID = "superpowers@zcode-plugins-official";

export async function writeWorkspaceConfigWithoutSuperpowers(
  workspaceDir: string,
  extra: Record<string, unknown> = {},
): Promise<void> {
  await mkdir(join(workspaceDir, ".zcode"), { recursive: true });
  await writeFile(
    join(workspaceDir, ".zcode", "config.json"),
    JSON.stringify({
      ...extra,
      plugins: { enabledPlugins: { [SUPERPOWERS_PLUGIN_ID]: false } },
    }),
  );
}
