// [leo][WP-21] 启动 ACP agent 子进程并建立 stdio 连接（ndjson JSON-RPC）。
import { spawn, type ChildProcess } from "node:child_process";
import { Readable, Writable } from "node:stream";
import {
  ClientSideConnection,
  ndJsonStream,
  PROTOCOL_VERSION,
  type InitializeResponse,
  type Stream,
} from "@agentclientprotocol/sdk";
import type { AcpLaunchSpec } from "./catalog.js";
import type { AcpSessionHost } from "./session.js";

export interface AcpAgentConnection {
  readonly connection: ClientSideConnection;
  readonly initialize: InitializeResponse;
  readonly sessionId: string;
  /** 会话是从 agent 的历史里恢复的（session/load），不是新建的。 */
  readonly resumed: boolean;
  dispose(): void;
}

export interface ConnectAcpAgentOptions {
  host: AcpSessionHost;
  cwd: string;
  /** 上次的 ACP 会话 id；agent 支持 loadSession 时优先恢复。 */
  resumeSessionId?: string;
  clientVersion?: string;
  onStderr?: (chunk: string) => void;
  /** [fix-remote] agent 进程退出（握手后也算）：管理器据此丢掉死连接、让进行中的回合以可读错误结束。 */
  onExit?: (code: number | null, signal: NodeJS.Signals | null) => void;
  /** [fix-remote] agent 要求 authenticate 时优先试的方法 id（来自本机登录状态，见 catalog）。 */
  authPreference?: readonly string[];
  /** 各握手阶段的超时（毫秒），测试可调小。 */
  stageTimeouts?: Partial<Record<AcpStage, number>>;
}

export type AcpStage = "initialize" | "authenticate" | "newSession";

const STAGE_TIMEOUTS: Record<AcpStage, number> = { initialize: 30_000, authenticate: 20_000, newSession: 60_000 };

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
  const connection = new ClientSideConnection(() => handlers, stream);
  const initialize = await withStageTimeout(
    connection.initialize({
      protocolVersion: PROTOCOL_VERSION,
      // 不声明 fs / terminal：文件读写与命令由 agent 自己执行，LeoBot 只负责审批与展示。
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      clientInfo: { name: "LeoBot", version: options.clientVersion ?? "0" },
    }),
    "initialize",
    options,
  );
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
      if (!isAuthRequired(error)) throw error;
      await authenticate(error);
      return withStageTimeout(run(), "newSession", options);
    }
  };
  let sessionId: string | undefined;
  let resumed = false;
  if (options.resumeSessionId && initialize.agentCapabilities?.loadSession) {
    try {
      await open(() =>
        connection.loadSession({ sessionId: options.resumeSessionId!, cwd: options.cwd, mcpServers: [] }),
      );
      sessionId = options.resumeSessionId;
      resumed = true;
    } catch (error) {
      if (error instanceof AcpStageTimeoutError || isAuthRequired(error)) throw error;
      sessionId = undefined;
    }
  }
  if (!sessionId) {
    const created = await open(() => connection.newSession({ cwd: options.cwd, mcpServers: [] }));
    sessionId = created.sessionId;
  }
  options.host.attach({ agent: connection, sessionId });
  return { connection, initialize, sessionId, resumed, dispose };
}

export async function spawnAcpAgent(
  launch: AcpLaunchSpec,
  options: ConnectAcpAgentOptions,
): Promise<AcpAgentConnection> {
  const child: ChildProcess = spawn(launch.command, launch.args, {
    cwd: options.cwd,
    env: launch.env,
    stdio: ["pipe", "pipe", "pipe"],
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
  const dispose = () => {
    if (child.exitCode === null && !child.killed) child.kill("SIGTERM");
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
