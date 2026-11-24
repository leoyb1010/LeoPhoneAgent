// [leo][WP-21] 启动 ACP agent 子进程并建立 stdio 连接（ndjson JSON-RPC）。
import { spawn, type ChildProcess } from "node:child_process";
import { Readable, Writable } from "node:stream";
import {
  ClientSideConnection,
  ndJsonStream,
  PROTOCOL_VERSION,
  type InitializeResponse,
  type SessionConfigOption,
  type Stream,
} from "@agentclientprotocol/sdk";
import type { AcpLaunchSpec, AcpProviderBinding } from "./catalog.js";
import type { AcpSessionHost } from "./session.js";

export interface AcpAgentConnection {
  readonly connection: ClientSideConnection;
  readonly initialize: InitializeResponse;
  readonly sessionId: string;
  /** 会话是从 agent 的历史里恢复的（session/load），不是新建的。 */
  readonly resumed: boolean;
  /** 在发送前由同一 Agent 确认新的模型选项。 */
  setModel?(modelId: string): Promise<void>;
  dispose(): void;
}

export interface ConnectAcpAgentOptions {
  host: AcpSessionHost;
  cwd: string;
  /** 上次的 ACP 会话 id；agent 支持 loadSession 时优先恢复。 */
  resumeSessionId?: string;
  customModelId?: string;
  providerBinding?: AcpProviderBinding;
  clientVersion?: string;
  onStderr?: (chunk: string) => void;
  /** [fix-remote] agent 进程退出（握手后也算）：管理器据此丢掉死连接、让进行中的回合以可读错误结束。 */
  onExit?: (code: number | null, signal: NodeJS.Signals | null) => void;
  /** [fix-remote] agent 要求 authenticate 时优先试的方法 id（来自本机登录状态，见 catalog）。 */
  authPreference?: readonly string[];
  /** 各握手阶段的超时（毫秒），测试可调小。 */
  stageTimeouts?: Partial<Record<AcpStage, number>>;
  /** 收进程时 SIGTERM 之后等多久补 SIGKILL（毫秒），测试可调小。 */
  killGraceMs?: number;
}

const KILL_GRACE_MS = 5_000;

export type AcpStage = "initialize" | "authenticate" | "newSession" | "setModel";

const STAGE_TIMEOUTS: Record<AcpStage, number> = {
  initialize: 30_000, authenticate: 20_000, newSession: 60_000, setModel: 25_000,
};

/** [fix-remote] 握手某一步没有回应：报出卡在哪一步，而不是让手机一直转圈。 */
export class AcpStageTimeoutError extends Error {
  readonly stage: AcpStage;
  readonly timeoutMs: number;
  constructor(stage: AcpStage, timeoutMs: number) {
    super(`ACP agent 卡在 ${stage}（${Math.round(timeoutMs / 1000)}s 无响应）`);
    this.name = "AcpStageTimeoutError";
    this.stage = stage;
    this.timeoutMs = timeoutMs;
  }
}

function withStageTimeout<T>(promise: Promise<T>, stage: AcpStage, options: ConnectAcpAgentOptions): Promise<T> {
  const ms = options.stageTimeouts?.[stage] ?? STAGE_TIMEOUTS[stage];
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new AcpStageTimeoutError(stage, ms)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function isAuthRequired(error: unknown): boolean {
  const record = error && typeof error === "object" ? (error as { code?: unknown; message?: unknown }) : {};
  return record.code === -32000 || /auth(entication)? required/i.test(String(record.message ?? ""));
}

/** 按本机偏好排序 agent 声明的登录方法（偏好里没有的按 agent 的顺序排在后面）。 */
export function orderAuthMethods(methods: readonly { id: string }[], preference: readonly string[] = []): string[] {
  const ids = methods.map((method) => method.id);
  return [...preference.filter((id) => ids.includes(id)), ...ids.filter((id) => !preference.includes(id))];
}

/** 测试与真实进程共用：给定双向流建立连接、握手并开会话。 */
export async function connectAcpStream(
  stream: Stream,
  options: ConnectAcpAgentOptions,
  dispose: () => void = () => undefined,
): Promise<AcpAgentConnection> {
  const handlers = options.host.clientHandlers();
  const gateway = options.providerBinding;
  let configOptions: readonly SessionConfigOption[] = [];
  const connection = new ClientSideConnection(() => ({
    ...handlers,
    sessionUpdate(update) {
      if (update.update.sessionUpdate === "config_option_update") {
        configOptions = update.update.configOptions;
      }
      return handlers.sessionUpdate(update);
    },
  }), stream);
  const initialize = await withStageTimeout(
    connection.initialize({
      protocolVersion: PROTOCOL_VERSION,
      // 不声明 fs / terminal：文件读写与命令由 agent 自己执行，LeoBot 只负责审批与展示。
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false,
        ...(gateway ? { auth: { _meta: { gateway: true } } } : {}),
      },
      clientInfo: { name: "LeoBot", version: options.clientVersion ?? "0" },
    }),
    "initialize",
    options,
  );
  if (gateway) {
    if (!initialize.authMethods?.some((method) => method.id === "gateway")) {
      throw new Error("当前 CLI 适配器无法使用已配置的供应商，请重新选择执行路径。");
    }
    // Use the adapter's task-scoped routing, which takes precedence over local settings and login.
    await withStageTimeout(connection.authenticate({
      methodId: "gateway",
      _meta: {
        gateway: {
          baseUrl: gateway.baseUrl.replace(/\/+$/u, ""),
          headers: { Authorization: `Bearer ${gateway.apiKey}` },
        },
      },
    }), "authenticate", options);
  }
  // [fix-remote] 已登录的 agent 通常不需要 authenticate；只有开会话报 auth_required 时，按本机登录状态挑方法
  // 调一次 authenticate 再重试（grok 即使已登录也要先选方法，否则报 no auth method id provided）。
  let authenticated = false;
  const authenticate = async (cause: unknown): Promise<void> => {
    const methods = orderAuthMethods(initialize.authMethods ?? [], options.authPreference);
    if (authenticated || methods.length === 0) throw cause;
    authenticated = true;
    let last: unknown = cause;
    for (const methodId of methods) {
      try {
        await withStageTimeout(connection.authenticate({ methodId }), "authenticate", options);
        return;
      } catch (error) {
        last = error;
        // 某个方法卡住（等设备授权之类）就别再试下一个：报卡在 authenticate。
        if (error instanceof AcpStageTimeoutError) throw error;
      }
    }
    throw isAuthRequired(last) ? last : cause;
  };
  const open = async <T>(run: () => Promise<T>): Promise<T> => {
    try {
      return await withStageTimeout(run(), "newSession", options);
    } catch (error) {
      if (options.providerBinding || !isAuthRequired(error)) throw error;
      await authenticate(error);
      return withStageTimeout(run(), "newSession", options);
    }
  };
  let sessionId: string | undefined;
  let resumed = false;
  let legacyModelId: string | undefined;
  const rememberSessionConfig = (response: { configOptions?: SessionConfigOption[] | null }) => {
    if (response.configOptions) configOptions = response.configOptions;
    // 一些旧 ACP 适配器只在开会话时报告 models.currentModelId。
    const legacy = (response as { models?: { currentModelId?: unknown } }).models;
    if (typeof legacy?.currentModelId === "string") legacyModelId = legacy.currentModelId;
  };
  if (options.resumeSessionId && initialize.agentCapabilities?.loadSession) {
    try {
      const loaded = await open(() =>
        connection.loadSession({ sessionId: options.resumeSessionId!, cwd: options.cwd, mcpServers: [] }),
      );
      rememberSessionConfig(loaded);
      sessionId = options.resumeSessionId;
      resumed = true;
    } catch (error) {
      if (gateway || error instanceof AcpStageTimeoutError || isAuthRequired(error)) throw error;
      sessionId = undefined;
    }
  }
  if (!sessionId) {
    if (gateway && options.resumeSessionId) {
      throw new Error("当前 CLI 无法恢复原任务，请新建任务后再发送。");
    }
    const created = await open(() => connection.newSession({ cwd: options.cwd, mcpServers: [] }));
    sessionId = created.sessionId;
    rememberSessionConfig(created);
  }
  const resolvedSessionId = sessionId;
  const modelOption = () => configOptions.find(
    (option) => option.type === "select" && (option.category === "model" || option.id === "model"),
  );
  const setModel = async (modelId: string): Promise<void> => {
    const current = modelOption();
    if (!current) {
      if (legacyModelId === modelId) return;
      throw new Error(`CLI 未报告可确认的模型，无法使用「${modelId}」。请检查本机 CLI 的模型配置。`);
    }
    if (current.currentValue === modelId) return;
    const result = await withStageTimeout(
      connection.setSessionConfigOption({ sessionId: resolvedSessionId, configId: current.id, value: modelId }),
      "setModel",
      options,
    ).catch((cause: unknown) => {
      if (cause instanceof AcpStageTimeoutError) throw cause;
      throw new Error(`CLI 未接受模型「${modelId}」。请检查模型 ID 和 CLI 的服务商设置。`, { cause });
    });
    configOptions = result.configOptions;
    if (modelOption()?.currentValue !== modelId) {
      throw new Error(`CLI 未确认模型「${modelId}」，该轮尚未发送。`);
    }
  };
  if (options.customModelId) await setModel(options.customModelId);
  options.host.attach({ agent: connection, sessionId });
  return { connection, initialize, sessionId, resumed, setModel, dispose };
}

export async function spawnAcpAgent(
  launch: AcpLaunchSpec,
  options: ConnectAcpAgentOptions,
): Promise<AcpAgentConnection> {
  // [fix] agent 会再起子进程（claude-code-acp → claude、npx → node…），只杀直接子进程会留下孤儿：
  // 非 Windows 上让它自成进程组，收的时候按组杀。Windows 没有进程组信号，仍只杀直接子进程。
  const groupKill = process.platform !== "win32";
  const child: ChildProcess = spawn(launch.command, launch.args, {
    cwd: options.cwd,
    env: launch.env,
    stdio: ["pipe", "pipe", "pipe"],
    detached: groupKill,
  });
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => options.onStderr?.(chunk));
  child.once("exit", (code, signal) => options.onExit?.(code, signal));
  const exited = new Promise<never>((_, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) =>
      reject(new Error(`ACP agent 已退出（code=${code ?? "null"} signal=${signal ?? "null"}）`)),
    );
  });
  exited.catch(() => undefined);
  const stream = ndJsonStream(
    Writable.toWeb(child.stdin!) as WritableStream<Uint8Array>,
    Readable.toWeb(child.stdout!) as ReadableStream<Uint8Array>,
  );
  const signal = (name: NodeJS.Signals) => {
    try {
      if (groupKill && child.pid) process.kill(-child.pid, name);
      else child.kill(name);
    } catch {
      // ESRCH：进程（组）已经没了。
    }
  };
  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    signal("SIGTERM");
    // SIGTERM 不理的，宽限期后补 SIGKILL（按组：直接子进程先退了、孙进程还在的也一并收掉）。
    const timer = setTimeout(() => signal("SIGKILL"), options.killGraceMs ?? KILL_GRACE_MS);
    timer.unref();
  };
  try {
    return await Promise.race([
      connectAcpStream(
        stream,
        { ...options, ...(launch.authPreference ? { authPreference: launch.authPreference } : {}) },
        dispose,
      ),
      exited,
    ]);
  } catch (error) {
    dispose();
    throw error;
  }
}
