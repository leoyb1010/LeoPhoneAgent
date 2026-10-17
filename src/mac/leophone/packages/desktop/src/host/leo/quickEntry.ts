import { stat } from "node:fs/promises";

import {
  ISettingService,
  IWindowControllerService,
  IZCodeTaskService,
  type ServiceCollection,
} from "@zcode/services";
import type { AppSettings } from "@zcode/shared";

/**
 * [leo] 菜单栏与 ⌥Space 快速派发的 Host 侧(规则见 docs/specs/leo-quick-entry.md)。
 * 任务状态的唯一所有者是 Host:主进程只轮询 summary、转发 dispatch,自己不存任务状态。
 */

export type QuickTaskState = "waiting" | "running" | "error" | "done" | "idle";

export interface QuickTaskRow {
  taskId: string;
  title: string;
  workspacePath: string;
  workspaceIdentity?: string;
  state: QuickTaskState;
  updatedAt: number;
}

export interface QuickSummary {
  waiting: QuickTaskRow[];
  running: QuickTaskRow[];
  recent: QuickTaskRow[];
  /** 可派发的工作区(本机路径),第一个是默认值。 */
  workspaces: string[];
}

/** controller 列表行里摘要用得到的字段(liveStatus 与侧栏同源,含实时 phase 与待审批)。 */
export interface QuickSourceItem {
  taskId: string;
  title?: string;
  workspacePath: string;
  workspaceIdentity?: string;
  updatedAt: number;
  unreadAt?: number;
  liveStatus?: "idle" | "running" | "waiting" | "completed" | "error";
  status?: "running" | "completed" | "error";
}

const RUNNING_LIMIT = 5;
const RECENT_LIMIT = 3;
const WAITING_LIMIT = 10;
const WORKSPACE_LIMIT = 5;
const QUICK_PROMPT_MAX_CHARS = 20_000;

function stateOf(item: QuickSourceItem): QuickTaskState {
  // 没有 controller 的实时投影时退回 tasks-index 落盘状态(只会少报待审批,不会误报)。
  const live = item.liveStatus ?? (item.status === "running" ? "running" : item.status === "error" ? "error" : "completed");
  if (live === "waiting") return "waiting";
  if (live === "running") return "running";
  if (live === "error" && item.unreadAt) return "error";
  if (live === "completed" && item.unreadAt) return "done";
  return "idle";
}

export function summarizeQuickTasks(items: readonly QuickSourceItem[], workspaces: string[]): QuickSummary {
  const rows = [...items]
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .map(
      (item): QuickTaskRow => ({
        taskId: item.taskId,
        title: item.title?.trim() || "未命名任务",
        workspacePath: item.workspacePath,
        ...(item.workspaceIdentity ? { workspaceIdentity: item.workspaceIdentity } : {}),
        state: stateOf(item),
        updatedAt: item.updatedAt,
      }),
    );
  return {
    waiting: rows.filter((row) => row.state === "waiting").slice(0, WAITING_LIMIT),
    running: rows.filter((row) => row.state === "running").slice(0, RUNNING_LIMIT),
    recent: rows.slice(0, RECENT_LIMIT),
    workspaces,
  };
}

/** 当前打开的本机工作区在前,再补最近项目;去重、只留磁盘上还在的目录,最多 5 个。 */
export async function resolveQuickWorkspaces(
  settings: Pick<AppSettings, "recentProjects" | "lastWorkspaceSession"> | undefined,
  isDirectory: (path: string) => Promise<boolean> = defaultIsDirectory,
): Promise<string[]> {
  const candidates = [
    ...(settings?.lastWorkspaceSession ?? [])
      .filter((entry) => entry.kind === "local")
      .map((entry) => entry.workspacePath),
    ...(settings?.recentProjects ?? []),
  ];
  const result: string[] = [];
  for (const raw of candidates) {
    const path = typeof raw === "string" ? raw.trim() : "";
    if (!path.startsWith("/") || result.includes(path)) continue;
    if (!(await isDirectory(path))) continue;
    result.push(path);
    if (result.length >= WORKSPACE_LIMIT) break;
  }
  return result;
}

async function defaultIsDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

export class QuickDispatchError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** 派发参数校验:工作区必须是 summary 给过的那几个之一,不接受任意路径。 */
export function validateQuickDispatch(
  body: Record<string, unknown>,
  workspaces: readonly string[],
): { workspacePath: string; prompt: string } {
  const prompt = typeof body["prompt"] === "string" ? body["prompt"].trim() : "";
  if (!prompt) throw new QuickDispatchError(400, "任务内容是空的");
  if (prompt.length > QUICK_PROMPT_MAX_CHARS) throw new QuickDispatchError(413, "任务内容太长");
  const requested = typeof body["workspacePath"] === "string" ? body["workspacePath"].trim() : "";
  const workspacePath = requested || workspaces[0] || "";
  if (!workspacePath) throw new QuickDispatchError(409, "还没有打开过工作区,先在 LeoBot 里打开一个项目");
  if (!workspaces.includes(workspacePath)) throw new QuickDispatchError(400, "只能派到最近的工作区");
  return { workspacePath, prompt };
}

export interface LeoQuickEntry {
  summary(): Promise<QuickSummary>;
  dispatch(body: Record<string, unknown>): Promise<{ taskId: string; workspacePath: string }>;
}

/** 菜单栏轮询时工作区列表的缓存时长:读设置 + stat 不必每 3 秒做一遍。派发总是现读。 */
const WORKSPACE_CACHE_MS = 10_000;

export function createLeoQuickEntry(services: ServiceCollection): LeoQuickEntry {
  const workspaces = async () =>
    resolveQuickWorkspaces(await services.getOptional(ISettingService)?.get().catch(() => undefined));
  let cached: { at: number; value: string[] } | null = null;
  const cachedWorkspaces = async () => {
    if (cached && Date.now() - cached.at < WORKSPACE_CACHE_MS) return cached.value;
    cached = { at: Date.now(), value: await workspaces() };
    return cached.value;
  };
  return {
    async summary() {
      const scopes = await cachedWorkspaces();
      if (scopes.length === 0) return summarizeQuickTasks([], scopes);
      const query = {
        kind: "active" as const,
        workspaceScopes: scopes.map((workspacePath) => ({ workspacePath })),
        sortBy: "updated" as const,
        limit: 40,
      };
      // 与侧栏同一个 controller 投影:liveStatus 带实时 phase 与待审批,tasks-index 只有落盘状态。
      const controller = services.getOptional(IWindowControllerService);
      if (controller) {
        const result = await controller.listTaskList(query);
        return summarizeQuickTasks(result.items, scopes);
      }
      const result = await services.get(IZCodeTaskService).listTaskList(query);
      return summarizeQuickTasks(result.items, scopes);
    },
    async dispatch(body) {
      const fresh = await workspaces();
      cached = { at: Date.now(), value: fresh };
      const { workspacePath, prompt } = validateQuickDispatch(body, fresh);
      const taskService = services.get(IZCodeTaskService);
      // 与闲时派发同一条无界面路径:先建空 session(首条输入时才落库),再发首条输入。
      // 不指定 mode / model:跟随工作区默认,和手机上开任务一致。
      const task = await taskService.createTask({ workspacePath, deferPersistenceUntilFirstPrompt: true });
      await taskService.sendPrompt({
        taskId: task.taskId,
        traceId: task.traceId,
        content: prompt,
        clientMode: "desktop-continuous",
      });
      return { taskId: task.taskId, workspacePath };
    },
  };
}
