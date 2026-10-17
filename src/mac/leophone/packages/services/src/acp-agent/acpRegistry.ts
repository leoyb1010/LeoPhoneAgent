// [leo][WP-21] 外部 agent（ACP）在宿主侧的事实：随包适配器的位置、本机各 agent 的可用状态。
// 会话本身跑在 CLI 进程里（apps/zcode-cli/packages/adapters/src/acp），这里只负责
//   1. 把随包的 claude-agent-acp 入口告诉 CLI（LEO_CLAUDE_AGENT_ACP_ENTRY）；
//   2. 给 UI / Leo Link 列出可用的外部 agent。
import { existsSync } from "node:fs";
import { findZCodeAgentRuntimeNodeBundle } from "#src/runtime-tools/providerRuntimeResolver.js";
import { dirname, join } from "node:path";
import { ACP_AGENTS, type AcpAgentId } from "@zcode/shared/acp";
import {
  CLAUDE_AGENT_ACP_PACKAGE,
  CODEX_ACP_PACKAGE,
  detectAcpAgents,
  resolveClaudeAgentAcpEntry,
  resolveCodexAcpEntry,
  type AcpAgentStatus,
} from "@zcode/shared/acp-detect";

/** 打包态：prepare-agent-node-bundle 把适配器 stage 在 glm/acp/node_modules 下。 */
export function resolveStagedClaudeAgentAcpEntry(agentBundlePath: string): string | undefined {
  const entry = join(
    dirname(agentBundlePath),
    "acp",
    "node_modules",
    ...CLAUDE_AGENT_ACP_PACKAGE.split("/"),
    "dist",
    "index.js",
  );
  return existsSync(entry) ? entry : undefined;
}

/** [fix-remote] 打包态：codex-acp 同样 stage 在 glm/acp/node_modules 下（dist/index.js）。 */
export function resolveStagedCodexAcpEntry(agentBundlePath: string): string | undefined {
  const entry = join(dirname(agentBundlePath), "acp", "node_modules", ...CODEX_ACP_PACKAGE.split("/"), "dist", "index.js");
  return existsSync(entry) ? entry : undefined;
}

/** 宿主进程里能找到的适配器入口：打包态在 CLI bundle 旁边，开发态从 node_modules 解析。 */
export function hostClaudeAgentAcpEntry(): string | undefined {
  const bundle = findZCodeAgentRuntimeNodeBundle();
  return (bundle ? resolveStagedClaudeAgentAcpEntry(bundle) : undefined) ?? resolveClaudeAgentAcpEntry();
}

export function hostCodexAcpEntry(): string | undefined {
  const bundle = findZCodeAgentRuntimeNodeBundle();
  return (bundle ? resolveStagedCodexAcpEntry(bundle) : undefined) ?? resolveCodexAcpEntry();
}

export interface AcpAgentListing extends AcpAgentStatus {
  name: string;
  harnessKey: string;
}

export function listAcpAgents(options: { claudeAgentAcpEntry?: string } = {}): AcpAgentListing[] {
  const entry = options.claudeAgentAcpEntry ?? resolveClaudeAgentAcpEntry();
  const statuses = detectAcpAgents({ resolveClaudeAgentAcpEntry: () => entry });
  return statuses.map((status) => {
    const info = ACP_AGENTS.find((agent) => agent.id === status.id)!;
    return { ...status, name: info.name, harnessKey: info.harnessKey };
  });
}

export function listAvailableAcpAgentIds(options: { claudeAgentAcpEntry?: string } = {}): AcpAgentId[] {
  // 单测与诊断用：LEO_ACP_AGENTS=off 时不探测本机（结果不随开发机装了哪些 CLI 而变）。
  if (process.env.LEO_ACP_AGENTS === "off") return [];
  return listAcpAgents(options)
    .filter((agent) => agent.available)
    .map((agent) => agent.id);
}
