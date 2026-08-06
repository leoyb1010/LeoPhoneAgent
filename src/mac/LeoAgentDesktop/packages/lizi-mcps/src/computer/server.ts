import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { jsonObjectArg } from '../json-object-arg.js';
import { resolvePathInsideRoot, PathBoundaryError } from '../shared/assertInsidePath.js';
import type {
  ComputerMcpCallContext,
  ComputerMcpDeps,
  ComputerMcpToolName,
  LiziMcpSessionContext,
} from '../types.js';
import {
  callComputerTool,
  COMPUTER_TOOLS,
  COMPUTER_TOOL_NAMES,
  getComputerTool,
} from './tools.js';
import { logToolResultErrorCode } from '../tool-error-telemetry.js';
import { WindowSnapshotTracker } from './snapshot-tracker.js';

export interface ComputerMcpServerOptions {
  sessionId?: string;
  getSessionContext?: () => LiziMcpSessionContext;
}

const DESCRIPTION_LIST =
  'Discover local desktop computer-use tools. These tools operate on the user desktop through the installed driver. ' +
  'Use read-only status/get_accessibility_tree/list_apps/list_windows/get_window_state before click/type_text/press_key/hotkey.';

const DESCRIPTION_CALL =
  'Invoke a local desktop computer-use tool. Arguments are validated before dispatching to the host driver.';

function textResult(value: unknown, isError?: boolean) {
  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify(value),
      },
    ],
    ...(isError ? { isError: true as const } : {}),
  };
}

const SESSION_AWARE_TOOLS = new Set<ComputerMcpToolName>([
  'list_windows',
  'get_window_state',
  'click',
  'double_click',
  'right_click',
  'drag',
  'type_text',
  'set_value',
  'press_key',
  'hotkey',
  'scroll',
  'move_cursor',
  'get_agent_cursor_state',
]);

const SESSION_LIFECYCLE_TOOLS = new Set<ComputerMcpToolName>([
  'start_recording',
]);

/**
 * LLM-supplied local filesystem path args per tool. The driver writes/reads
 * these on the user's disk, so an unconstrained absolute path is a
 * prompt-injection write/read primitive. Every listed arg is resolved and
 * constrained to the session workingDir before dispatch (see guardPathArgs).
 * Omitting the arg leaves the driver's own default behavior untouched.
 */
const COMPUTER_PATH_ARGS: Partial<Record<ComputerMcpToolName, readonly string[]>> = {
  get_window_state: ['screenshot_out_file'],
  click: ['debug_image_out'],
  start_recording: ['output_dir'],
  replay_trajectory: ['dir'],
};

/** 接受 element_index 的动作工具——只有它们参与快照代际校验(见 snapshot-tracker.ts)。 */
const ELEMENT_INDEX_ACTION_TOOLS = new Set<ComputerMcpToolName>([
  'click',
  'double_click',
  'right_click',
  'type_text',
  'set_value',
  'press_key',
  'scroll',
]);

function serializeJsonSchema(schema: z.ZodObject<z.ZodRawShape>): unknown {
  try {
    return z.toJSONSchema(schema);
  } catch {
    return '<schema serialization failed>';
  }
}

function validationError(name: string, schema: z.ZodObject<z.ZodRawShape>, error: z.ZodError) {
  return textResult(
    {
      ok: false,
      errorCode: 'INVALID_ARGS',
      data: {
        tool: name,
        validation_errors: error.issues,
        schema: serializeJsonSchema(schema),
      },
    },
    true,
  );
}

/** Values retained so INVALID_ARGS can explain an alias/canonical mismatch. */
interface CompatibilityAliasConflict {
  alias: string;
  canonical: string;
  aliasValue: unknown;
  canonicalValue: unknown;
}

/**
 * Normalizes only aliases observed in real failed Computer Use calls. An alias
 * is removed only when the canonical arg is absent or equal; conflicting valid
 * values are rejected, while invalid types fall through to strict Zod parsing.
 * If cua-driver adopts either alias as a real field, remove that alias here
 * before exposing the new driver schema so we never shadow a canonical field.
 */
function normalizeCompatibilityArgs(
  name: string,
  args: Record<string, unknown>,
): { args: Record<string, unknown>; conflict?: CompatibilityAliasConflict } {
  const normalized = { ...args };

  if (name === 'list_windows' && typeof normalized.app === 'string') {
    if (normalized.process_name === undefined || normalized.process_name === normalized.app) {
      normalized.process_name = normalized.app;
      delete normalized.app;
    } else if (typeof normalized.process_name === 'string') {
      return {
        args: normalized,
        conflict: {
          alias: 'app',
          canonical: 'process_name',
          aliasValue: normalized.app,
          canonicalValue: normalized.process_name,
        },
      };
    }
  }

  if (name === 'get_window_state' && normalized.screenshot === true) {
    if (normalized.capture_mode === undefined || normalized.capture_mode === 'vision') {
      normalized.capture_mode = 'vision';
      delete normalized.screenshot;
    } else if (normalized.capture_mode === 'som' || normalized.capture_mode === 'ax') {
      return {
        args: normalized,
        conflict: {
          alias: 'screenshot',
          canonical: 'capture_mode',
          aliasValue: true,
          canonicalValue: normalized.capture_mode,
        },
      };
    }
  }

  return { args: normalized };
}

/** Returns alias conflicts through the same schema-bearing INVALID_ARGS shape. */
function compatibilityAliasConflictError(
  name: string,
  schema: z.ZodObject<z.ZodRawShape>,
  conflict: CompatibilityAliasConflict,
) {
  return textResult(
    {
      ok: false,
      errorCode: 'INVALID_ARGS',
      data: {
        tool: name,
        validation_errors: [{
          path: [conflict.alias],
          message:
            `Compatibility alias ${conflict.alias} conflicts with ${conflict.canonical}; use only ${conflict.canonical}.`,
          alias_value: conflict.aliasValue,
          canonical_value: conflict.canonicalValue,
        }],
        schema: serializeJsonSchema(schema),
      },
    },
    true,
  );
}

function withSessionArg(
  name: ComputerMcpToolName,
  args: Record<string, unknown>,
  sessionId?: string,
): Record<string, unknown> {
  if (!sessionId) {
    return args;
  }
  if (name === 'get_agent_cursor_state' || name === 'move_cursor') {
    return {
      ...args,
      cursor_id: sessionId,
      ...(name === 'move_cursor' ? { session: sessionId } : {}),
    };
  }
  if (!SESSION_AWARE_TOOLS.has(name) && !SESSION_LIFECYCLE_TOOLS.has(name)) {
    return args;
  }
  return {
    ...args,
    session: sessionId,
  };
}

function readCallContext(options: ComputerMcpServerOptions): ComputerMcpCallContext | undefined {
  const sessionContext = options.getSessionContext?.();
  const sessionId = sessionContext?.sessionId ?? options.sessionId;
  const agentKind = sessionContext?.agentKind;
  return sessionId || agentKind
    ? {
        ...(sessionId ? { sessionId } : {}),
        ...(agentKind ? { agentKind } : {}),
      }
    : undefined;
}

function readSessionId(options: ComputerMcpServerOptions): string | undefined {
  return readCallContext(options)?.sessionId;
}

export function createComputerMcpServer(
  deps: ComputerMcpDeps,
  options: ComputerMcpServerOptions = {},
): McpServer {
  const server = new McpServer({ name: 'cindy_computer', version: '0.1.0' });
  // 快照代际状态。claude 路径下每 session 一个 server 实例;codex HTTP bridge 下
  // 单实例跨 session 共享,所以 tracker 内部按 sessionId 分键。
  const snapshotTracker = new WindowSnapshotTracker();

  server.tool('list_tools', DESCRIPTION_LIST, {}, async () =>
    textResult({
      ok: true,
      tools: COMPUTER_TOOLS.map((tool) => ({
        name: tool.name,
        description: tool.description,
        readOnly: tool.readOnly === true,
        inputSchema: z.toJSONSchema(z.object(tool.inputShape).strict()),
      })),
      workflow:
        'Start with status and check_permissions. Then use get_accessibility_tree/list_windows, optionally narrow list_windows with query/workspace_root/process_name (for example, {"process_name":"Simulator"}), inspect a target with get_window_state, perform one action, and call get_window_state again to verify. Targeted actions such as click/type_text require pid; include window_id whenever the target window is known, and always for coordinates. Use get_window_state with {"capture_mode":"vision"} for screenshots and normally omit screenshot_out_file. Element indices are only valid for the latest snapshot of the same pid/window_id: pass the snapshot_id from get_window_state along with element_index, and re-observe when an action is rejected with STALE_SNAPSHOT. Use start_recording/stop_recording/replay_trajectory only when the user explicitly asks for recording or replay.',
    }),
  );

  server.tool(
    'call_tool',
    DESCRIPTION_CALL,
    {
      name: z.enum(COMPUTER_TOOL_NAMES).describe('Tool name from list_tools'),
      args: jsonObjectArg('Arguments object for the selected tool'),
    },
    async ({ name, args }) => {
      const result = await handleCallTool(name, args);
      // errorCode 遥测:UNKNOWN_TOOL / INVALID_ARGS / COMPUTER_DRIVER_ERROR 返回给
      // 模型自纠之前在这里落一条日志(见 tool-error-telemetry.ts)。
      logToolResultErrorCode({
        logger: deps.logger,
        server: 'cindy_computer',
        tool: name,
        result,
        sessionId: readSessionId(options),
      });
      return result;
    },
  );

  async function handleCallTool(name: string, args: Record<string, unknown> | undefined) {
    const def = getComputerTool(name);
    if (!def) {
      return textResult({ ok: false, errorCode: 'UNKNOWN_TOOL', data: { requested: name } }, true);
    }

    const schema = z.object(def.inputShape).strict();
    const normalized = normalizeCompatibilityArgs(name, args ?? {});
    if (normalized.conflict) {
      return compatibilityAliasConflictError(name, schema, normalized.conflict);
    }
    const parsed = schema.safeParse(normalized.args);
    if (!parsed.success) {
      return validationError(name, schema, parsed.error);
    }
    const callContext = readCallContext(options);
    const sessionId = callContext?.sessionId;
    const parsedData = parsed.data as Record<string, unknown>;

    // 快照代际护栏:element_index 指向"某次 get_window_state 的第几项",观察和
    // 动作之间 UI 树变化时会静默作用到错误元素。带 snapshot_id 的动作在此校验
    // 它是否仍是目标窗口最新观察;不带的放行(过渡兼容)但打遥测日志。
    const staleResult = checkSnapshotFreshness(name as ComputerMcpToolName, parsedData, sessionId);
    if (staleResult) return staleResult;
    // snapshot_id 是 MCP 层的护栏参数,driver 不认识,派发前剥掉。
    delete parsedData.snapshot_id;

    // 路径边界护栏:把 LLM 指定的本地文件路径(截图 / 调试图 / 录制目录等)
    // 约束到当前 session workingDir,阻断 prompt 注入的任意写/读(见 COMPUTER_PATH_ARGS)。
    const pathGuardError = await guardPathArgs(name as ComputerMcpToolName, parsedData);
    if (pathGuardError) return pathGuardError;

    const parsedArgs = withSessionArg(
      name as ComputerMcpToolName,
      parsedData,
      sessionId,
    );

    try {
      const data = await callComputerTool(
        deps,
        name as ComputerMcpToolName,
        parsedArgs,
        callContext,
      );
      const snapshotId = recordWindowSnapshot(name as ComputerMcpToolName, parsedData, data, sessionId);
      return textResult({
        ok: true,
        tool: name,
        ...(snapshotId ? { snapshot_id: snapshotId } : {}),
        data,
      });
    } catch (err) {
      return textResult(
        {
          ok: false,
          errorCode: 'COMPUTER_DRIVER_ERROR',
          data: { message: err instanceof Error ? err.message : String(err) },
        },
        true,
      );
    }
  }

  /**
   * 把工具入参里的本地文件路径约束到 session workingDir。返回 null 放行(路径
   * 已被替换为约束后的绝对路径),返回结果对象表示以 PATH_NOT_ALLOWED 拒绝。
   * 无 workingDir 时对显式传入的路径 fail-closed(driver 侧无 in-package 默认可回落,
   * 缺省 arg 时才由 driver 自己决定默认,不受影响)。
   */
  async function guardPathArgs(
    name: ComputerMcpToolName,
    parsedData: Record<string, unknown>,
  ) {
    const argNames = COMPUTER_PATH_ARGS[name];
    if (!argNames) return null;
    const workingDir = options.getSessionContext?.().workingDir ?? '';
    for (const key of argNames) {
      const value = parsedData[key];
      if (typeof value !== 'string' || value.length === 0) continue;
      if (!workingDir || workingDir.trim().length === 0) {
        return textResult(
          {
            ok: false,
            errorCode: 'PATH_NOT_ALLOWED',
            data: {
              tool: name,
              arg: key,
              message: key === 'screenshot_out_file'
                ? '当前会话无 workingDir，出于安全禁止写入该本地路径。请省略 screenshot_out_file 由 driver 使用默认路径；如需显式路径，请在具有 workingDir 的会话中使用其内部路径。'
                : '当前会话无 workingDir，出于安全禁止写入/读取该本地路径。',
            },
          },
          true,
        );
      }
      try {
        parsedData[key] = await resolvePathInsideRoot(workingDir, value);
      } catch (e) {
        if (e instanceof PathBoundaryError) {
          return textResult(
            {
              ok: false,
              errorCode: 'PATH_NOT_ALLOWED',
              data: {
                tool: name,
                arg: key,
                message: key === 'screenshot_out_file'
                  ? `${e.message} 请省略 screenshot_out_file 由 driver 使用默认路径，或将其改为当前 workingDir 内的路径。`
                  : e.message,
              },
            },
            true,
          );
        }
        throw e;
      }
    }
    return null;
  }

  /**
   * element_index 动作的快照新鲜度校验。返回 null 表示放行;
   * 返回结果对象表示直接以 STALE_SNAPSHOT 拒绝(不派发 driver)。
   */
  function checkSnapshotFreshness(
    name: ComputerMcpToolName,
    parsedData: Record<string, unknown>,
    sessionId: string | undefined,
  ) {
    if (!ELEMENT_INDEX_ACTION_TOOLS.has(name)) return null;
    if (typeof parsedData.element_index !== 'number') return null;
    const pid = parsedData.pid as number;
    const windowId = typeof parsedData.window_id === 'number' ? parsedData.window_id : undefined;

    const snapshotId = typeof parsedData.snapshot_id === 'string' ? parsedData.snapshot_id : undefined;
    if (!snapshotId) {
      // 过渡兼容:老调用方 / 未升级的 agent 不带 snapshot_id,放行但留痕,
      // 后续可据此评估何时收紧为强制。
      deps.logger?.warn('element_index action without snapshot_id', {
        server: 'cindy_computer',
        tool: name,
        ...(sessionId ? { sessionId } : {}),
      });
      return null;
    }

    const verdict = snapshotTracker.validate(sessionId, snapshotId, pid, windowId);
    if (verdict.ok) return null;
    return textResult(
      {
        ok: false,
        errorCode: 'STALE_SNAPSHOT',
        data: {
          tool: name,
          snapshot_id: snapshotId,
          reason: verdict.reason,
          hint:
            'The element_index comes from a window snapshot that is no longer the latest observation of this window, so the target element may have moved or changed. Call get_window_state again for this pid/window_id, then retry with the fresh snapshot_id and element_index.',
        },
      },
      true,
    );
  }

  /** get_window_state 成功观察后登记新一代快照;其余工具或观察失败时返回 null。 */
  function recordWindowSnapshot(
    name: ComputerMcpToolName,
    parsedData: Record<string, unknown>,
    data: unknown,
    sessionId: string | undefined,
  ): string | null {
    if (name !== 'get_window_state') return null;
    if (typeof parsedData.pid !== 'number' || typeof parsedData.window_id !== 'number') return null;
    // driver 层失败(data.ok === false)不算一次有效观察,不发新代。
    if (data && typeof data === 'object' && !Array.isArray(data)
      && (data as { ok?: unknown }).ok === false) {
      return null;
    }
    const snapshotId = snapshotTracker.record(sessionId, parsedData.pid, parsedData.window_id);
    const driverSnapshotId = readDriverSnapshotId(data);
    if (driverSnapshotId) {
      snapshotTracker.registerAlias(snapshotId, driverSnapshotId);
    }
    return snapshotId;
  }

  return server;
}

function readDriverSnapshotId(data: unknown): string | null {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  const direct = (data as { snapshot_id?: unknown }).snapshot_id;
  if (typeof direct === 'string' && direct.trim().length > 0) return direct;

  const elements = (data as { elements?: unknown }).elements;
  if (!Array.isArray(elements)) return null;
  for (const element of elements) {
    if (!element || typeof element !== 'object') continue;
    const token = (element as { element_token?: unknown }).element_token;
    if (typeof token !== 'string') continue;
    const colonIndex = token.indexOf(':');
    if (colonIndex > 0) return token.slice(0, colonIndex);
  }
  return null;
}
