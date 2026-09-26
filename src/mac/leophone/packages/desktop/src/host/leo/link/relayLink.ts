import { execFile, spawn } from "node:child_process";
import dns from "node:dns";
import type { LookupFunction } from "node:net";
import { promisify } from "node:util";

import WebSocket from "ws";

import type { LinkBridge, LinkRequest } from "./bridge.js";
import type { HarnessEvent } from "./journal.js";
import type { Caller, CallerKind } from "./session.js";

type Logger = { info: (msg: string, meta?: unknown) => void; warn: (msg: string, meta?: unknown) => void };

export type RelayConfig = {
  /** wss://…/relay/agent */
  wsUrl: string;
  /** 本机在中继里的名字(和 leoagent 一样取短主机名),手机按它找到这台 Mac。 */
  name: string;
  /** 首次注册用的钥匙:中继 0.1 的主钥匙,或 0.2 的 Mac 注册钥匙。 */
  registerKey: string;
};

export type MachineKeyStore = { get(): Promise<string | null>; set(key: string): Promise<void> };

/** 给 Mac 上「连接手机」面板看的连接状态;不含任何钥匙。 */
export type RelayLinkStatus = {
  connected: boolean;
  /** 中继回执里的版本;0.1 不带,记成 "0.1"。 */
  relayVersion: string | null;
  /** 最近一次连上的时间(毫秒)。 */
  connectedAt: number | null;
  lastError: string | null;
  lastErrorAt: number | null;
};

const PING_INTERVAL_MS = 25_000;
const PONG_TIMEOUT_MS = 75_000;
const STREAM_KEEPALIVE_MS = 25_000;
const OUTBOX_LIMIT = 200;
const CALLER_KINDS = new Set<CallerKind>(["iphone", "legacy", "master"]);
const TAILNET_DNS = "100.100.100.100";

/**
 * tailnet 域名(`*.ts.net`)用 Tailscale 自己的 DNS 解析。本机开着代理(Clash TUN)时,系统解析
 * 会给出代理的假 IP,和中继之间的常驻连接就绕到代理节点上:实测每个来回 2~3 秒,直连 tailnet 只要
 * 几十毫秒。解析不到(没开 Tailscale、不是 tailnet 域名)就退回系统解析。
 */
export function tailnetLookup(servers: string[] = [TAILNET_DNS]): LookupFunction {
  const resolver = new dns.Resolver({ timeout: 1500, tries: 1 });
  resolver.setServers(servers);
  return ((hostname: string, options: dns.LookupOptions, callback: (...args: unknown[]) => void) => {
    const fallback = () => dns.lookup(hostname, options, callback as never);
    if (!hostname.endsWith(".ts.net")) return fallback();
    resolver.resolve4(hostname, (error, addresses) => {
      if (error || addresses.length === 0) return fallback();
      if (options.all) callback(null, addresses.map((address) => ({ address, family: 4 })));
      else callback(null, addresses[0], 4);
    });
  }) as LookupFunction;
}

/** 中继 0.2 转发时附带调用方;0.1 没有,记成 unknown。 */
export function callerFrom(frame: Record<string, unknown>): Caller {
  const raw = frame["caller"];
  if (!raw || typeof raw !== "object") return { kind: "unknown" };
  const obj = raw as Record<string, unknown>;
  const kind = String(obj["kind"] ?? "") as CallerKind;
  return {
    kind: CALLER_KINDS.has(kind) ? kind : "unknown",
    ...(obj["device_id"] ? { deviceId: String(obj["device_id"]) } : {}),
    ...(obj["name"] ? { name: String(obj["name"]) } : {}),
  };
}

/**
 * [leo-link] 挂到自营中继上的出站 WebSocket(移植自 leocodebox relay-client.service.ts)。
 * 帧协议与 relay.py 对偶:register / registered / http / resp / stream_open / stream_data /
 * stream_keepalive / stream_close / stream_cancel / event。
 * 与旧版的区别:请求在进程内交给 LinkBridge,不再绕本机 HTTP;注册时要求钉扎机器名(0.2),
 * 领到的机器专属钥匙存进钥匙串,之后只用它注册。
 */
export class RelayLink {
  private stopped = false;
  private activeWs: WebSocket | null = null;
  /** 中继拒了存着的机器钥匙;领到新钥匙前改用注册钥匙。 */
  private machineKeyRejected = false;
  private readonly outbox: Record<string, unknown>[] = [];
  private readonly streamAborts = new Map<string, AbortController>();
  private readonly state: RelayLinkStatus = {
    connected: false,
    relayVersion: null,
    connectedAt: null,
    lastError: null,
    lastErrorAt: null,
  };

  constructor(
    private readonly config: RelayConfig,
    private readonly bridge: LinkBridge,
    private readonly machineKeys: MachineKeyStore,
    private readonly logger: Logger,
    private readonly appVersion: string | null,
  ) {}

  start(): void {
    void this.runForever();
  }

  status(): RelayLinkStatus {
    return { ...this.state };
  }

  /** 机器专属钥匙(中继 0.2 钉扎后才有);签发配对码时优先用它。 */
  machineKey(): Promise<string | null> {
    return this.machineKeys.get();
  }

  stop(): void {
    this.stopped = true;
    try {
      this.activeWs?.terminate();
    } catch {
      // 已经断了
    }
  }

  /** 已落盘的审批与终态推给中继(它决定发不发 APNs);断线时攒着,重连补发,超限丢最旧的。 */
  pushEvent(event: HarnessEvent): void {
    const frame = { type: "event", machine: this.config.name, event };
    const ws = this.activeWs;
    if (ws && ws.readyState === WebSocket.OPEN) {
      try {
        ws.send(JSON.stringify(frame));
        return;
      } catch {
        // 落进 outbox
      }
    }
    this.outbox.push(frame);
    while (this.outbox.length > OUTBOX_LIMIT) this.outbox.shift();
  }

  private async runForever(): Promise<void> {
    let backoff = 1;
    while (!this.stopped) {
      try {
        await this.runOnce();
        backoff = 1;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.state.lastError = message;
        this.state.lastErrorAt = Date.now();
        this.logger.warn("[leo/link] relay disconnected", { error: message });
      }
      this.state.connected = false;
      if (this.stopped) break;
      await new Promise((resolve) => setTimeout(resolve, backoff * 1000));
      backoff = Math.min(backoff * 2, 30);
    }
  }

  private async runOnce(): Promise<void> {
    const machineKey = this.machineKeyRejected ? null : await this.machineKeys.get();
    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(this.config.wsUrl, { handshakeTimeout: 15_000, lookup: tailnetLookup() });
      this.activeWs = ws;
      let lastPong = Date.now();
      let pingTimer: NodeJS.Timeout | null = null;
      let settled = false;

      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        if (pingTimer) clearInterval(pingTimer);
        if (this.activeWs === ws) this.activeWs = null;
        this.state.connected = false;
        for (const controller of this.streamAborts.values()) controller.abort();
        this.streamAborts.clear();
        try {
          ws.terminate();
        } catch {
          // already closed
        }
        if (error) reject(error);
        else resolve();
      };

      ws.on("open", () => {
        ws.send(JSON.stringify({
          type: "register",
          name: this.config.name,
          key: machineKey ?? this.config.registerKey,
          // 中继 0.2:首次注册领取机器专属钥匙,名字从此只认它;0.1 忽略这个字段。
          pin: true,
          info: { platform: "leoagent", server: "leophoneagent", version: this.appVersion },
        }));
        lastPong = Date.now();
        pingTimer = setInterval(() => {
          if (Date.now() - lastPong > PONG_TIMEOUT_MS) {
            finish(new Error("relay heartbeat lost"));
            return;
          }
          try {
            ws.ping();
          } catch {
            // closing
          }
        }, PING_INTERVAL_MS);
      });
      ws.on("pong", () => {
        lastPong = Date.now();
      });
      ws.on("ping", () => {
        lastPong = Date.now();
      });

      ws.on("message", (data) => {
        let frame: Record<string, unknown>;
        try {
          frame = JSON.parse(String(data)) as Record<string, unknown>;
        } catch {
          return;
        }
        switch (frame["type"]) {
          case "registered":
            this.logger.info("[leo/link] connected to relay", { name: this.config.name, relay: frame["version"] ?? "0.1" });
            this.state.connected = true;
            this.state.connectedAt = Date.now();
            this.state.relayVersion = typeof frame["version"] === "string" ? frame["version"] : "0.1";
            // 0.2 起回执带 version,并且每个请求都附调用方:从此认不出身份的请求按旧版设备对待。
            this.bridge.strictCallers = typeof frame["version"] === "string";
            if (typeof frame["machine_key"] === "string" && frame["machine_key"]) {
              this.machineKeyRejected = false;
              void this.machineKeys.set(frame["machine_key"]).catch((error: unknown) =>
                this.logger.warn("[leo/link] storing machine key failed", { error: String(error) }));
            }
            this.flushOutbox(ws);
            break;
          case "http":
            void this.handleHttp(ws, frame);
            break;
          case "stream_open":
            void this.handleStream(ws, frame);
            break;
          case "stream_cancel":
            this.streamAborts.get(String(frame["id"]))?.abort();
            break;
          default:
            break;
        }
      });
      ws.on("close", (code, reason) => {
        // 中继不认存着的机器钥匙(4001:被解钉、中继状态丢了、首次存钥匙没存上):下一次用注册钥匙重新领,
        // 不然永远 4001、手机一直看到 Mac 离线。
        if (code === 4001 && machineKey) this.machineKeyRejected = true;
        finish(new Error(`relay closed (${code}${reason?.length ? ` ${reason.toString()}` : ""})`));
      });
      ws.on("error", (error) => finish(error instanceof Error ? error : new Error(String(error))));
    });
  }

  private send(ws: WebSocket, frame: Record<string, unknown>): void {
    if (ws.readyState !== WebSocket.OPEN) return;
    try {
      ws.send(JSON.stringify(frame));
    } catch {
      // 连接正在关;手机会重试
    }
  }

  private flushOutbox(ws: WebSocket): void {
    const pending = this.outbox.splice(0, this.outbox.length);
    for (const frame of pending) {
      if (ws.readyState !== WebSocket.OPEN) {
        this.outbox.push(frame);
        continue;
      }
      this.send(ws, frame);
    }
  }

  private request(frame: Record<string, unknown>): LinkRequest {
    const requestId = typeof frame["request_id"] === "string" && frame["request_id"] ? frame["request_id"] : undefined;
    return {
      method: String(frame["method"] ?? "GET"),
      path: String(frame["path"] ?? "/"),
      body: frame["body"],
      caller: callerFrom(frame),
      ...(requestId ? { requestId } : {}),
    };
  }

  private async handleHttp(ws: WebSocket, frame: Record<string, unknown>): Promise<void> {
    const id = frame["id"];
    try {
      const response = await this.bridge.handle(this.request(frame));
      this.send(ws, { type: "resp", id, status: response.status, body: response.body });
    } catch (error) {
      this.send(ws, {
        type: "resp",
        id,
        status: 500,
        body: { error: { message: error instanceof Error ? error.message : String(error) } },
      });
    }
  }

  private async handleStream(ws: WebSocket, frame: Record<string, unknown>): Promise<void> {
    const id = String(frame["id"]);
    const controller = new AbortController();
    this.streamAborts.set(id, controller);
    // 经 NAT / 代理的长连接要有心跳;中继把它转成 SSE 注释帧。
    const keepAlive = setInterval(() => this.send(ws, { type: "stream_keepalive", id }), STREAM_KEEPALIVE_MS);
    try {
      await this.bridge.stream(this.request(frame), (data) => this.send(ws, { type: "stream_data", id, data }), controller.signal);
    } catch (error) {
      if (!controller.signal.aborted) this.logger.warn("[leo/link] stream failed", { error: String(error) });
    } finally {
      clearInterval(keepAlive);
      this.streamAborts.delete(id);
      this.send(ws, { type: "stream_close", id });
    }
  }
}

/**
 * 机器专属钥匙存 macOS 钥匙串。写入走 `security -i` 的标准输入,钥匙不出现在
 * 命令行参数里(`ps` 看不到);Host 进程没有别的钥匙串通道。
 */
export function keychainMachineKeyStore(rawAccount: string, service = "com.leoyuan.leophoneagent.link"): MachineKeyStore {
  const run = promisify(execFile);
  // 机器名来自主机名或环境变量,会被写进 `security -i` 的命令行:只留安全字符,挡掉引号、反引号、$ 这类注入。
  const account = rawAccount.replace(/[^A-Za-z0-9._-]/g, "_") || "mac";
  return {
    async get() {
      try {
        const { stdout } = await run("/usr/bin/security", ["find-generic-password", "-s", service, "-a", account, "-w"]);
        const key = stdout.trim();
        return key || null;
      } catch {
        return null;
      }
    },
    async set(key: string) {
      if (!/^[A-Za-z0-9_\-.~+/=]{16,512}$/.test(key)) throw new Error("unexpected machine key format");
      await new Promise<void>((resolve, reject) => {
        const child = spawn("/usr/bin/security", ["-i"], { stdio: ["pipe", "ignore", "pipe"] });
        let stderr = "";
        child.stderr.on("data", (chunk) => {
          stderr += String(chunk);
        });
        child.on("error", reject);
        child.on("close", (code) => (code === 0 && !stderr.trim() ? resolve() : reject(new Error(stderr.trim() || `security exited ${code}`))));
        child.stdin.end(`add-generic-password -U -s "${service}" -a "${account}" -w "${key}"\n`);
      });
    },
  };
}
