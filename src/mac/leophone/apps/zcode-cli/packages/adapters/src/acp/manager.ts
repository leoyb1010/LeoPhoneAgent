// [leo][WP-21] 每个 LeoBot 会话一个 ACP agent 进程：启动、落盘会话 id（重启后 session/load 接上）、
// 闲置回收、stderr 尾部与失败描述。从 model.ts 拆出（单文件 400 行上限）。
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  ACP_COMMANDS_FILE,
  parseAcpCommandsStore,
  recordAcpAgentCommands,
  type AcpAgentCommand,
  type AcpAgentId,
} from "@zcode/shared/acp";
import { detectAcpAgent, resolveAcpLaunch, type AcpEnvironment } from "./catalog.js";
import {
  acpUnavailableError,
  appendStderrTail,
  describeAcpFailure,
  emptyTurnError,
  redactAgentOutput,
  type AcpAgentError,
} from "./errors.js";
import { spawnAcpAgent, type AcpAgentConnection } from "./process.js";
import { AcpSessionHost } from "./session.js";

/** 闲置这么久（没开轮、没收到 agent 更新）的 agent 进程收掉；下次发消息自动拉起并 session/load 续上。 */
const ACP_IDLE_REAP_MS = 30 * 60_000;
const ACP_IDLE_SWEEP_MS = 60_000;
/** stderr 合并成一秒一条 debug 日志（agent 刷屏时不逐块写日志）。 */
const ACP_STDERR_FLUSH_MS = 1_000;

type AcpManagerLogger = {
  warn(message: string, context?: Record<string, unknown>): void;
  info?(message: string, context?: Record<string, unknown>): void;
  debug?(message: string, context?: Record<string, unknown>): void;
};

type AcpEntry = {
  host: AcpSessionHost;
  connection: Promise<AcpAgentConnection>;
  /** 握手完成后的连接（同步收进程要用，进程退出钩子里不能等 Promise）。 */
  connected?: AcpAgentConnection;
  /** 不支持 session/load 的 agent 闲置时只记一次日志、不回收。 */
  idleLogged?: boolean;
};

/** 每个 LeoBot 会话一个 agent 进程；会话 id 落盘，重启后用 session/load 接上。 */
export class AcpSessionManager {
  readonly #entries = new Map<string, AcpEntry>();
  readonly #environment: AcpEnvironment;
  readonly #statePath: string;
  readonly #commandsPath: string;
  readonly #connect: typeof spawnAcpAgent;
  readonly #logger: AcpManagerLogger | undefined;
  /** [fix-remote] 每个 LeoBot 会话最近的 agent stderr（失败时附在错误里）；进程重启时清空。 */
  readonly #stderrTails = new Map<string, string[]>();
  readonly #idleMs: number;
  #sweepTimer: NodeJS.Timeout | undefined;

  constructor(
    options: {
      environment?: AcpEnvironment;
      statePath?: string;
      commandsPath?: string;
      connect?: typeof spawnAcpAgent;
      logger?: AcpManagerLogger;
      /** 闲置回收阈值（毫秒），测试可调。 */
      idleMs?: number;
    } = {},
  ) {
    this.#environment = options.environment ?? {};
    const root = process.env.ZCODE_HOME?.trim() || join(homedir(), ".leophoneagent");
    this.#statePath = options.statePath ?? join(root, "cli", "acp-sessions.json");
    this.#commandsPath = options.commandsPath ?? join(dirname(this.#statePath), ACP_COMMANDS_FILE);
    this.#connect = options.connect ?? spawnAcpAgent;
    this.#logger = options.logger;
    this.#idleMs = options.idleMs ?? ACP_IDLE_REAP_MS;
  }

  /** 取（必要时启动）某个 LeoBot 会话对应的 agent。 */
  async ensure(
    leoSessionId: string,
    agentId: AcpAgentId,
    cwd: string,
  ): Promise<{ host: AcpSessionHost; connection: AcpAgentConnection }> {
    let entry = this.#entries.get(leoSessionId);
    if (entry && entry.host.agentId !== agentId) {
      this.dispose(leoSessionId);
      entry = undefined;
    }
    if (!entry) {
      const host = new AcpSessionHost(agentId, {
        onCommands: (commands) => this.#writeCommands(agentId, cwd, commands),
      });
      const launch = resolveAcpLaunch(agentId, this.#environment);
      const tail: string[] = [];
      this.#stderrTails.set(leoSessionId, tail);
      // [fix] 以前每块 stderr 一条 warn：agent 一刷屏日志就爆。改成一秒合并成一条 debug，失败时才带尾部写 warn。
      let stderrBuffer = "";
      let stderrTimer: NodeJS.Timeout | undefined;
      const flushStderr = () => {
        stderrTimer = undefined;
        // stderr 可能带出令牌（长期令牌经 env 传给了 claude）：脱敏后再进日志。
        if (stderrBuffer) this.#logger?.debug?.("ACP agent stderr", { agentId, chunk: redactAgentOutput(stderrBuffer.slice(-2000)) });
        stderrBuffer = "";
      };
      const connection = launch
        ? this.#connect(launch, {
            host,
            cwd,
            resumeSessionId: this.#readState()[leoSessionId]?.acpSessionId,
            onStderr: (chunk) => {
              appendStderrTail(tail, chunk);
              stderrBuffer = (stderrBuffer + chunk).slice(-8000);
              stderrTimer ??= setTimeout(flushStderr, ACP_STDERR_FLUSH_MS);
              stderrTimer.unref?.();
            },
            onExit: (code, signal) => {
              if (stderrTimer) clearTimeout(stderrTimer);
              flushStderr();
              const reaped = this.#entries.get(leoSessionId)?.host !== host;
              // 进程没了：丢掉这条死连接（下一轮重新拉起），进行中的回合以错误结束。
              if (!reaped) this.#entries.delete(leoSessionId);
              if (!reaped && code !== 0) {
                this.#logger?.warn("ACP agent exited", { agentId, code, signal, stderrTail: redactAgentOutput(tail.join("\n")) });
              }
              host.failTurn(new Error(`ACP agent 已退出（code=${code ?? "null"} signal=${signal ?? "null"}）`));
            },
          })
        : Promise.reject(
            acpUnavailableError(agentId, detectAcpAgent(agentId, this.#environment).unavailableReason),
          );
      const created: AcpEntry = { host, connection };
      entry = created;
      this.#entries.set(leoSessionId, entry);
      this.#startSweep();
      connection.then(
        (connected) => {
          created.connected = connected;
          this.#writeState(leoSessionId, agentId, connected.sessionId);
        },
        () => {
          if (this.#entries.get(leoSessionId)?.host === host) this.#entries.delete(leoSessionId);
        },
      );
    }
    return { host: entry.host, connection: await entry.connection };
  }

  /** [fix-remote] 空回合（没有任何产出就结束）按失败报。 */
  describeEmptyTurn(leoSessionId: string, agentId: AcpAgentId, stopReason: string): AcpAgentError {
    return this.#logFailure(
      emptyTurnError({ agentId, stopReason, stderrTail: this.#stderrTails.get(leoSessionId) ?? [] }),
    );
  }

  /** [fix-remote] 把失败包成「哪个 agent、什么原因、怎么修 + stderr 尾部」的错误。 */
  describeFailure(leoSessionId: string, agentId: AcpAgentId, error: unknown): AcpAgentError {
    return this.#logFailure(
      describeAcpFailure({ agentId, error, stderrTail: this.#stderrTails.get(leoSessionId) ?? [] }),
    );
  }

  #logFailure(error: AcpAgentError): AcpAgentError {
    // detail 是已脱敏的 stderr 尾部。
    this.#logger?.warn("ACP agent turn failed", { agentId: error.agentId, kind: error.kind, message: error.message, stderrTail: error.detail });
    return error;
  }

  host(leoSessionId: string): AcpSessionHost | undefined {
    return this.#entries.get(leoSessionId)?.host;
  }

  dispose(leoSessionId: string): void {
    const entry = this.#entries.get(leoSessionId);
    if (!entry) return;
    this.#entries.delete(leoSessionId);
    this.#stderrTails.delete(leoSessionId);
    void entry.host.cancel();
    // 已连上的同步收（进程退出钩子里 Promise 回调不会再跑）；还在握手的等握手结束再收。
    if (entry.connected) entry.connected.dispose();
    else entry.connection.then((connected) => connected.dispose(), () => undefined);
    if (this.#entries.size === 0) this.#stopSweep();
  }

  disposeAll(): void {
    for (const id of [...this.#entries.keys()]) this.dispose(id);
    this.#stopSweep();
  }

  /**
   * 回收闲置的 agent 进程：没在跑、没有挂着的授权、超过阈值没动静。
   * 只回收支持 session/load 的 agent（下次 ensure 用落盘的会话 id 续上）；续不上的只记一次日志，留着进程。
   */
  reapIdle(now = Date.now()): string[] {
    const reaped: string[] = [];
    for (const [leoSessionId, entry] of [...this.#entries]) {
      const { host, connected } = entry;
      if (!connected || host.turnActive || host.hasPendingPermission) continue;
      if (now - host.lastActivityAt < this.#idleMs) continue;
      if (!connected.initialize.agentCapabilities?.loadSession) {
        if (!entry.idleLogged) {
          entry.idleLogged = true;
          this.#logger?.info?.("ACP agent idle but cannot session/load; keeping process", { agentId: host.agentId });
        }
        continue;
      }
      this.#logger?.info?.("ACP agent idle; reaping process", { agentId: host.agentId });
      this.dispose(leoSessionId);
      reaped.push(leoSessionId);
    }
    return reaped;
  }

  #startSweep(): void {
    if (this.#sweepTimer) return;
    this.#sweepTimer = setInterval(() => this.reapIdle(), Math.min(ACP_IDLE_SWEEP_MS, this.#idleMs));
    this.#sweepTimer.unref?.();
  }

  #stopSweep(): void {
    if (this.#sweepTimer) clearInterval(this.#sweepTimer);
    this.#sweepTimer = undefined;
  }

  #writeCommands(agentId: AcpAgentId, cwd: string, commands: readonly AcpAgentCommand[]): void {
    try {
      let current: unknown;
      try {
        current = JSON.parse(readFileSync(this.#commandsPath, "utf8"));
      } catch {
        current = undefined;
      }
      const next = recordAcpAgentCommands(parseAcpCommandsStore(current), agentId, cwd, commands);
      mkdirSync(dirname(this.#commandsPath), { recursive: true });
      writeFileSync(this.#commandsPath, JSON.stringify(next, null, 2));
    } catch (error) {
      this.#logger?.warn("ACP 斜杠命令写入失败", { error: String(error) });
    }
  }

  #readState(): Record<string, { agentId: string; acpSessionId: string }> {
    try {
      return JSON.parse(readFileSync(this.#statePath, "utf8")) as Record<
        string,
        { agentId: string; acpSessionId: string }
      >;
    } catch {
      return {};
    }
  }

  #writeState(leoSessionId: string, agentId: AcpAgentId, acpSessionId: string): void {
    try {
      const state = this.#readState();
      state[leoSessionId] = { agentId, acpSessionId };
      mkdirSync(dirname(this.#statePath), { recursive: true });
      writeFileSync(this.#statePath, JSON.stringify(state, null, 2));
    } catch (error) {
      this.#logger?.warn("ACP 会话映射写入失败", { error: String(error) });
    }
  }
}
