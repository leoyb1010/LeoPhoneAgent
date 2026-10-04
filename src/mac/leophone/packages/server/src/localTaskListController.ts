import { randomUUID } from "node:crypto";
import { isAbsolute, resolve } from "node:path";
import type {
  IWindowControllerService,
  IZCodeAgentService,
  IZCodeTaskService,
  ZCodeTaskListQuery,
  ZCodeTaskListWorkspaceScope,
} from "@zcode/services";
import type { ServerRemoteWorkspaceInfo } from "@zcode/shared";
import {
  controllerResyncParamsSchema,
  controllerSubscribeParamsSchema,
  controllerUnsubscribeParamsSchema,
} from "@zcode/shared/zcode-protocol-v4";
import { createWindowHostControllerRuntime } from "@zcode/services/window-controller-runtime";

function unsupported(message: string): Error {
  return Object.assign(new Error(message), { code: "WEB_TASK_STATUS_UNSUPPORTED" });
}

/** Server-declared local scopes only. This adapter never grants paths supplied by renderer tabs. */
export function createLocalTaskListController(options: {
  workspaces: readonly ServerRemoteWorkspaceInfo[];
  taskService: IZCodeTaskService;
  agentService?: IZCodeAgentService;
}) {
  const scopes = new Map<string, ZCodeTaskListWorkspaceScope>();
  for (const workspace of options.workspaces) {
    const workspacePath = resolve(workspace.path);
    const workspaceIdentity = workspace.workspaceIdentity?.trim() || undefined;
    const key = workspaceIdentity ?? workspacePath;
    const existing = scopes.get(key);
    if (existing && existing.workspacePath !== workspacePath) {
      throw unsupported("The server workspace identity has conflicting paths");
    }
    scopes.set(key, { workspacePath, ...(workspaceIdentity ? { workspaceIdentity } : {}) });
  }
  let disposed = false;
  const connections = new Set<{ dispose(): void }>();
  const runtime = createWindowHostControllerRuntime({
    createId: randomUUID,
    propagateSourceReadErrors: true,
    refreshSourcesOnList: true,
    resolveSource(scope) {
      const declared = scopes.get(scope.workspaceIdentity?.trim() || scope.workspacePath);
      if (!declared || declared.workspacePath !== scope.workspacePath) return null;
      return {
        scope: { kind: "local", ...declared },
        taskService: options.taskService,
        agentService: options.agentService,
        sourceAvailability: "online",
      };
    },
  });

  function validateQuery(query: ZCodeTaskListQuery): ZCodeTaskListQuery {
    if (!query || !["active", "pinned", "archived", "timeline"].includes(query.kind)
      || !["created", "updated"].includes(query.sortBy)
      || !Array.isArray(query.workspaceScopes) || query.workspaceScopes.length > 64
      || (query.search !== undefined && typeof query.search !== "string")
      || (query.limit !== undefined && (!Number.isSafeInteger(query.limit) || query.limit < 0))) {
      throw unsupported("Invalid local task-list query");
    }
    const workspaceScopes = query.workspaceScopes.map(scope => {
      if (!scope || typeof scope.workspacePath !== "string" || !isAbsolute(scope.workspacePath)
        || Object.hasOwn(scope, "remoteSessionId")
        || (scope.workspaceIdentity !== undefined && typeof scope.workspaceIdentity !== "string")) {
        throw unsupported("Only declared local workspaces are available in Web task status");
      }
      const workspacePath = resolve(scope.workspacePath);
      const workspaceIdentity = scope.workspaceIdentity?.trim() || undefined;
      const declared = scopes.get(workspaceIdentity ?? workspacePath);
      if (!declared || declared.workspacePath !== workspacePath
        || declared.workspaceIdentity !== workspaceIdentity) {
        throw unsupported("This workspace is not declared by the Web server");
      }
      return { ...declared };
    });
    return { kind: query.kind, sortBy: query.sortBy, workspaceScopes,
      ...(query.search !== undefined ? { search: query.search } : {}),
      ...(query.limit !== undefined ? { limit: query.limit } : {}) };
  }

  return {
    createConnection() {
      if (disposed) throw unsupported("Web task status is closed");
      const attachment = runtime.createAttachmentService();
      const owned = new Set<string>();
      let pendingSubscriptions = 0;
      let closed = false;
      const requireOpen = () => {
        if (closed || disposed) throw unsupported("Web task status is closed");
      };
      const requireOwned = (id: string) => {
        requireOpen();
        if (!owned.has(id)) throw unsupported("Subscription does not belong to this connection");
      };
      const rejectMutation = async (): Promise<never> => {
        requireOpen();
        throw unsupported("Web task status is read-only; use the existing scoped task service");
      };
      const service: IWindowControllerService = {
        async listTaskList(query) {
          requireOpen();
          const result = await attachment.listTaskList(validateQuery(query));
          requireOpen();
          return result;
        },
        mutateTask: rejectMutation,
        deleteArchivedTask: rejectMutation,
        deleteArchivedTasks: rejectMutation,
        async subscribeControllerV4(input) {
          requireOpen();
          const params = controllerSubscribeParamsSchema.parse(input);
          // 同步计入在途订阅，避免并发请求都在ACK前看到空owned集合而突破连接边界。
          if (owned.size + pendingSubscriptions >= 32) throw unsupported("Too many task-status subscriptions");
          pendingSubscriptions += 1;
          try {
            const result = await attachment.subscribeControllerV4(params);
            if (closed || disposed) {
              await attachment.unsubscribeControllerV4({ subscriptionId: result.ack.subscriptionId });
              throw unsupported("Web task status is closed");
            }
            owned.add(result.ack.subscriptionId);
            return result;
          } finally {
            pendingSubscriptions -= 1;
          }
        },
        async resyncControllerV4(input) {
          const params = controllerResyncParamsSchema.parse(input);
          requireOwned(params.subscriptionId);
          return attachment.resyncControllerV4(params);
        },
        async unsubscribeControllerV4(input) {
          const params = controllerUnsubscribeParamsSchema.parse(input);
          requireOwned(params.subscriptionId);
          await attachment.unsubscribeControllerV4(params);
          owned.delete(params.subscriptionId);
        },
        onDynamicControllerFrame() {
          requireOpen();
          return attachment.onDynamicControllerFrame();
        },
      };
      const connection = {
        service,
        dispose() {
          if (closed) return;
          closed = true;
          owned.clear();
          attachment.dispose();
          connections.delete(connection);
        },
      };
      connections.add(connection);
      return connection;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const connection of connections) connection.dispose();
      runtime.dispose();
    },
  };
}
