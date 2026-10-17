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
}

/** 测试与真实进程共用：给定双向流建立连接、握手并开会话。 */
export async function connectAcpStream(
  stream: Stream,
  options: ConnectAcpAgentOptions,
  dispose: () => void = () => undefined,
): Promise<AcpAgentConnection> {
  const handlers = options.host.clientHandlers();
  const connection = new ClientSideConnection(() => handlers, stream);
  const initialize = await connection.initialize({
    protocolVersion: PROTOCOL_VERSION,
    // 不声明 fs / terminal：文件读写与命令由 agent 自己执行，LeoBot 只负责审批与展示。
    clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
    clientInfo: { name: "LeoBot", version: options.clientVersion ?? "0" },
  });
  let sessionId: string | undefined;
  let resumed = false;
  if (options.resumeSessionId && initialize.agentCapabilities?.loadSession) {
    try {
      await connection.loadSession({
        sessionId: options.resumeSessionId,
        cwd: options.cwd,
        mcpServers: [],
      });
      sessionId = options.resumeSessionId;
      resumed = true;
    } catch {
      sessionId = undefined;
    }
  }
  if (!sessionId) {
    const created = await connection.newSession({ cwd: options.cwd, mcpServers: [] });
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
    return await Promise.race([connectAcpStream(stream, options, dispose), exited]);
  } catch (error) {
    dispose();
    throw error;
  }
}
