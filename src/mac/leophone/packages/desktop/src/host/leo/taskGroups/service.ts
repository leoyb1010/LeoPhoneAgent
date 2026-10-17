// [leo][WP-27] 并行任务组：同一个需求同时派给 N 个 agent（LeoBot 自己 + 外部 ACP agent），
// 每个 agent 在自己的 git worktree 里干活，互不干扰；用户对比各方案的改动，采纳一个落回原仓库，
// 然后一键清理全部 worktree。任务组状态落在 <数据根>/worktrees/groups.json，由 Host 独占。
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { acpAgentInfo, acpModelSelection, isAcpAgentId, type AcpAgentId } from "@zcode/shared/acp";

import {
  applyWorktreeToRepo,
  createLeoWorktree,
  leoWorktreesRoot,
  removeLeoWorktree,
  resolveRepoRoot,
  slugify,
  WorktreeError,
  worktreeDiff,
  git,
} from "./worktree.js";

export type TaskGroupAgent = { kind: "leo" } | { kind: "acp"; agentId: AcpAgentId };

export interface TaskGroupMember {
  id: string;
  label: string;
  agent: TaskGroupAgent;
  worktreePath: string;
  branch: string;
  /** 任务开在哪个目录（worktree，或其中用户所在的子目录）：界面据此打开任务。 */
  taskWorkspacePath: string;
  taskId?: string;
  error?: string;
  state: "active" | "merged" | "removed";
}

export interface TaskGroup {
  id: string;
  title: string;
  prompt: string;
  repoRoot: string;
  /** 用户发起任务组时所在的工作区（可能是仓库的子目录）。 */
  workspacePath: string;
  baseCommit: string;
  createdAt: number;
  state: "open" | "closed";
  mergedMemberId?: string;
  members: TaskGroupMember[];
}

export class TaskGroupError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export interface TaskGroupModelSelection {
  providerId: string;
  modelId: string;
  options?: Record<string, unknown>;
}

export interface TaskGroupTaskPort {
  createTask(input: {
    workspacePath: string;
    modelSelection?: TaskGroupModelSelection;
  }): Promise<{ taskId: string; traceId?: string }>;
  sendPrompt(input: { taskId: string; traceId?: string; content: string }): Promise<void>;
}

export interface LeoTaskGroups {
  list(): Promise<{ groups: TaskGroup[] }>;
  create(body: Record<string, unknown>): Promise<TaskGroup>;
  diff(body: Record<string, unknown>): Promise<{ files: Array<{ status: string; path: string }>; patch: string; truncated: boolean }>;
  merge(body: Record<string, unknown>): Promise<{ files: number; group: TaskGroup }>;
  cleanup(body: Record<string, unknown>): Promise<TaskGroup>;
}

const MAX_AGENTS = 4;
const PROMPT_MAX_CHARS = 20_000;
const DIFF_MAX_CHARS = 400_000;

function readStore(file: string): TaskGroup[] {
  if (!existsSync(file)) return [];
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as { groups?: TaskGroup[] };
    return Array.isArray(parsed.groups) ? parsed.groups : [];
  } catch {
    return [];
  }
}

function writeStore(file: string, groups: TaskGroup[]): void {
  mkdirSync(dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify({ version: 1, groups }, null, 2)}\n`);
  renameSync(temp, file);
}

export function parseTaskGroupAgents(value: unknown): TaskGroupAgent[] {
  if (!Array.isArray(value) || value.length === 0) throw new TaskGroupError(400, "至少选一个 agent");
  if (value.length > MAX_AGENTS) throw new TaskGroupError(400, `一组最多 ${MAX_AGENTS} 个 agent`);
  return value.map((entry): TaskGroupAgent => {
    const record = (entry ?? {}) as Record<string, unknown>;
    if (record["kind"] === "leo") return { kind: "leo" };
    if (record["kind"] === "acp" && isAcpAgentId(record["agentId"])) return { kind: "acp", agentId: record["agentId"] };
    throw new TaskGroupError(400, "不认识的 agent");
  });
}

function agentLabel(agent: TaskGroupAgent): string {
  return agent.kind === "leo" ? "LeoBot" : acpAgentInfo(agent.agentId).name;
}

function requireString(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  if (typeof value !== "string" || !value.trim()) throw new TaskGroupError(400, `缺少 ${key}`);
  return value.trim();
}

export function createLeoTaskGroups(deps: {
  tasks: TaskGroupTaskPort;
  /** 允许发起任务组的工作区（与快速派发同一份：最近打开的本机项目）。 */
  workspaces: () => Promise<string[]>;
  /**
   * LeoBot 自己那一份用哪个模型:用户配置的默认模型,不能是外部 agent(否则「LeoBot」方案其实是 Claude Code)。
   * undefined = 跟随工作区默认;null = 没有 LeoBot 可用的模型。
   */
  leoModelSelection?: () => Promise<TaskGroupModelSelection | null | undefined>;
  root?: string;
}): LeoTaskGroups {
  const root = deps.root ?? leoWorktreesRoot();
  const storeFile = join(root, "groups.json");
  let queue: Promise<unknown> = Promise.resolve();
  // 所有改动串行：两次点击「采纳」不能同时往原仓库打补丁。
  const serial = <T>(work: () => Promise<T>): Promise<T> => {
    const next = queue.then(work, work);
    queue = next.catch(() => undefined);
    return next;
  };
  const load = () => readStore(storeFile);
  const save = (groups: TaskGroup[]) => writeStore(storeFile, groups);
  const find = (body: Record<string, unknown>) => {
    const groups = load();
    const group = groups.find((candidate) => candidate.id === requireString(body, "groupId"));
    if (!group) throw new TaskGroupError(404, "任务组不存在");
    return { groups, group };
  };
  const findMember = (group: TaskGroup, body: Record<string, unknown>) => {
    const member = group.members.find((candidate) => candidate.id === requireString(body, "memberId"));
    if (!member) throw new TaskGroupError(404, "方案不存在");
    return member;
  };

  return {
    async list() {
      return { groups: load().sort((a, b) => b.createdAt - a.createdAt) };
    },

    create(body) {
      return serial(async () => {
        const prompt = requireString(body, "prompt");
        if (prompt.length > PROMPT_MAX_CHARS) throw new TaskGroupError(413, "任务内容太长");
        const agents = parseTaskGroupAgents(body["agents"]);
        const workspacePath = requireString(body, "workspacePath");
        if (!(await deps.workspaces()).includes(workspacePath)) {
          throw new TaskGroupError(400, "只能在最近打开的本机项目里发起任务组");
        }
        let repoRoot: string;
        try {
          repoRoot = await resolveRepoRoot(workspacePath);
        } catch (error) {
          throw new TaskGroupError(409, (error as Error).message);
        }
        const baseCommit = (await git(repoRoot, ["rev-parse", "HEAD"]).catch(() => "")).trim();
        if (!baseCommit) throw new TaskGroupError(409, "仓库还没有任何提交，先提交一次再开任务组");
        const id = randomBytes(4).toString("hex");
        const relativeWorkspace = workspacePath.startsWith(`${repoRoot}/`) ? workspacePath.slice(repoRoot.length + 1) : "";
        const members: TaskGroupMember[] = [];
        try {
          for (const [index, agent] of agents.entries()) {
            const label = agentLabel(agent);
            const slug = `${id}-${index + 1}-${slugify(label)}`;
            const created = await createLeoWorktree({ repoPath: repoRoot, slug, baseCommit, root });
            const taskWorkspacePath = relativeWorkspace ? join(created.worktreePath, relativeWorkspace) : created.worktreePath;
            members.push({
              taskWorkspacePath,
              id: `${index + 1}`,
              label,
              agent,
              worktreePath: created.worktreePath,
              branch: created.branch,
              state: "active",
            });
          }
        } catch (error) {
          for (const member of members) {
            await removeLeoWorktree({ repoRoot, worktreePath: member.worktreePath, branch: member.branch }).catch(() => undefined);
          }
          throw new TaskGroupError(500, error instanceof WorktreeError ? error.message : String(error));
        }
        // 各 agent 各开一个任务：工作区就是自己的 worktree（保留用户所在的子目录），首条输入同一份需求。
        const leoSelection = members.some((member) => member.agent.kind === "leo")
          ? await deps.leoModelSelection?.().catch(() => undefined)
          : undefined;
        for (const member of members) {
          try {
            if (member.agent.kind === "leo" && leoSelection === null) {
              throw new Error("LeoBot 还没有可用的模型，先在设置里配置一个");
            }
            const modelSelection =
              member.agent.kind === "acp" ? acpModelSelection(member.agent.agentId) : (leoSelection ?? undefined);
            const task = await deps.tasks.createTask({
              workspacePath: member.taskWorkspacePath,
              ...(modelSelection ? { modelSelection } : {}),
            });
            member.taskId = task.taskId;
            await deps.tasks.sendPrompt({ taskId: task.taskId, traceId: task.traceId, content: prompt });
          } catch (error) {
            member.error = error instanceof Error ? error.message : String(error);
          }
        }
        const title = typeof body["title"] === "string" && body["title"].trim() ? body["title"].trim() : prompt.split("\n")[0]!.slice(0, 60);
        const group: TaskGroup = {
          id,
          title,
          prompt,
          repoRoot,
          workspacePath,
          baseCommit,
          createdAt: Date.now(),
          state: "open",
          members,
        };
        save([group, ...load()]);
        return group;
      });
    },

    async diff(body) {
      const { group } = find(body);
      const member = findMember(group, body);
      if (member.state === "removed" || !existsSync(member.worktreePath)) {
        throw new TaskGroupError(410, "这个方案的 worktree 已经清理掉了");
      }
      const diff = await worktreeDiff(member.worktreePath, group.baseCommit);
      const truncated = diff.patch.length > DIFF_MAX_CHARS;
      return { files: diff.files, patch: truncated ? diff.patch.slice(0, DIFF_MAX_CHARS) : diff.patch, truncated };
    },

    merge(body) {
      return serial(async () => {
        const { groups, group } = find(body);
        const member = findMember(group, body);
        if (group.state === "closed" || member.state !== "active") throw new TaskGroupError(409, "这个方案已经不能采纳了");
        if (group.mergedMemberId) throw new TaskGroupError(409, "这个任务组已经采纳过一个方案");
        let result: { files: number };
        try {
          result = await applyWorktreeToRepo({ repoRoot: group.repoRoot, worktreePath: member.worktreePath, baseCommit: group.baseCommit });
        } catch (error) {
          throw new TaskGroupError(409, `落回原仓库失败（原仓库没改动）：${(error as Error).message}`);
        }
        member.state = "merged";
        group.mergedMemberId = member.id;
        save(groups);
        return { files: result.files, group };
      });
    },

    cleanup(body) {
      return serial(async () => {
        const { groups, group } = find(body);
        for (const member of group.members) {
          if (member.state === "removed") continue;
          await removeLeoWorktree({ repoRoot: group.repoRoot, worktreePath: member.worktreePath, branch: member.branch });
          if (member.state === "active") member.state = "removed";
        }
        group.state = "closed";
        save(groups);
        return group;
      });
    },
  };
}
