// [leo][WP-27] 并行任务组的界面侧类型与桥（window.leoTaskGroups，见 desktop preload/leoBridge.ts）。
// 任务组状态只在 Host；界面每次操作后重新 list。

export type LeoTaskGroupAgent = { kind: "leo" } | { kind: "acp"; agentId: string };

export interface LeoTaskGroupMember {
  id: string;
  label: string;
  agent: LeoTaskGroupAgent;
  worktreePath: string;
  taskWorkspacePath: string;
  branch: string;
  taskId?: string;
  error?: string;
  state: "active" | "merged" | "removed";
}

export interface LeoTaskGroup {
  id: string;
  title: string;
  prompt: string;
  repoRoot: string;
  workspacePath: string;
  createdAt: number;
  state: "open" | "closed";
  mergedMemberId?: string;
  members: LeoTaskGroupMember[];
}

export interface LeoTaskGroupDiff {
  files: Array<{ status: string; path: string }>;
  patch: string;
  truncated: boolean;
}

type BridgeResult = { ok: true; data: Record<string, unknown> } | { ok: false; error: string };

interface LeoTaskGroupsBridge {
  call(action: "list" | "create" | "diff" | "merge" | "cleanup", body?: unknown): Promise<BridgeResult>;
}

export function leoTaskGroupsBridge(): LeoTaskGroupsBridge | null {
  if (typeof window === "undefined") return null;
  return (window as unknown as { leoTaskGroups?: LeoTaskGroupsBridge }).leoTaskGroups ?? null;
}

async function call<T>(action: "list" | "create" | "diff" | "merge" | "cleanup", body?: unknown): Promise<T> {
  const bridge = leoTaskGroupsBridge();
  if (!bridge) throw new Error("并行任务组只在 macOS 桌面版可用");
  const result = await bridge.call(action, body);
  if (!result.ok) throw new Error(result.error);
  return (action === "list" ? result.data : result.data["result"]) as T;
}

export const leoTaskGroups = {
  list: async () => (await call<{ groups: LeoTaskGroup[] }>("list")).groups,
  create: (body: { workspacePath: string; prompt: string; agents: LeoTaskGroupAgent[] }) =>
    call<LeoTaskGroup>("create", body),
  diff: (groupId: string, memberId: string) => call<LeoTaskGroupDiff>("diff", { groupId, memberId }),
  merge: (groupId: string, memberId: string) =>
    call<{ files: number; group: LeoTaskGroup }>("merge", { groupId, memberId }),
  cleanup: (groupId: string) => call<LeoTaskGroup>("cleanup", { groupId }),
};

export interface LeoTaskGroupAgentChoice {
  key: string;
  label: string;
  agent: LeoTaskGroupAgent;
}

/** 可选的 agent：LeoBot 自己总在第一位，再加本机可用的外部 agent（ACP）。 */
export function taskGroupAgentChoices(
  acpAgents: ReadonlyArray<{ id: string; name: string; available: boolean }>,
): LeoTaskGroupAgentChoice[] {
  return [
    { key: "leo", label: "LeoBot", agent: { kind: "leo" } },
    ...acpAgents
      .filter((agent) => agent.available)
      .map((agent) => ({ key: `acp:${agent.id}`, label: agent.name, agent: { kind: "acp" as const, agentId: agent.id } })),
  ];
}

const inside = (path: string, root: string) => path === root || path.startsWith(`${root}/`);

/** 首页只显示还开着、且属于当前项目（同一仓库内，或正在看其中某个方案的 worktree）的任务组。 */
export function openGroupsForWorkspace(groups: readonly LeoTaskGroup[], workspacePath: string): LeoTaskGroup[] {
  return groups.filter(
    (group) =>
      group.state === "open" &&
      (inside(workspacePath, group.repoRoot) ||
        group.members.some((member) => inside(workspacePath, member.worktreePath))),
  );
}
