import { createHash, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import os from "node:os";

import type { ISettingService, IZCodeTaskService } from "@zcode/services";
import { leoDeviceDescriptorSchema, type LeoDeviceDescriptor } from "@zcode/shared/leo-device";

import { createSyncReplica, createTreasuryHandler } from "../sync/index.js";
import type { TreasuryStore } from "../treasuryStore.js";
import { leoPath } from "../leoPaths.js";
import { LinkBridge } from "./bridge.js";
import { DirectGrants } from "./directGrants.js";
import { startDirectServer } from "./directServer.js";
import { directConfig } from "./directSettings.js";
export { configureLeoDirect } from "./directSettings.js";
import { loadDeviceIdentity } from "./deviceIdentity.js";
import {
  createPairingCode,
  joinTokenFromPayload,
  probePairingSupport,
  relayHttpBase,
  revokePairingCode,
  type PairingCode,
  type PairingSupport,
} from "./pairing.js";
import type { HarnessEvent } from "./journal.js";
import {
  keychainMachineKeyStore,
  RelayLink,
  type RelayConfig,
  type RelayLinkStatus,
} from "./relayLink.js";

type Logger = {
  info: (msg: string, meta?: unknown) => void;
  warn: (msg: string, meta?: unknown) => void;
};

const LEOAGENT_URL = "http://127.0.0.1:8646";

function readJson(file: string): Record<string, unknown> | null {
  try {
    if (!existsSync(file)) return null;
    const parsed = JSON.parse(readFileSync(file, "utf8")) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * 开关在 `~/.leoagent/link.json`:`{"enabled": true}`。默认关 —— 切换前 Python leoagent
 * 还在用同一个机器名注册中继,两边都连会互相顶掉。切换脚本改完 leoagent 的 plist 才打开它。
 */
export function linkEnabled(): boolean {
  return readJson(leoPath("link.json"))?.["enabled"] === true;
}

/** 本机在中继里的名字:与 leoagent(socket.gethostname 的短名)一致,手机才找得到。 */
export function machineName(): string {
  return process.env["LEOAGENT_RELAY_NAME"]?.trim() || os.hostname().split(".")[0]!;
}

function readRelayJson(): { url: string; key: string } | null {
  const config = readJson(leoPath("relay.json"));
  const url = typeof config?.["url"] === "string" ? config["url"].trim() : "";
  const key = typeof config?.["key"] === "string" ? config["key"].trim() : "";
  return url && key ? { url, key } : null;
}

/** relay.json 变了(补上、换地址、换钥匙)要重连;拿它的内容当指纹。 */
export function relayConfigSignature(): string {
  return JSON.stringify({
    relay: readRelayJson(),
    direct: readJson(leoPath("link.json"))?.["direct"],
  });
}

/** 中继地址与注册钥匙:`~/.leoagent/relay.json {url, key}`,与 leoagent 共用。 */
export function resolveRelayConfig(): RelayConfig | null {
  const raw = readRelayJson();
  if (!raw) return null;
  const { url, key } = raw;
  let wsUrl = url.replace(/\/+$/, "");
  if (!wsUrl.endsWith("/relay/agent")) wsUrl = `${wsUrl}/relay/agent`;
  wsUrl = wsUrl.replace(/^https:\/\//, "wss://").replace(/^http:\/\//, "ws://");
  return { wsUrl, name: machineName(), registerKey: key };
}

/** 转给 leoagent 用的本机钥匙:切换后是它独享的一把,切换前沿用 `~/.leoagent/key`。 */
function leoagentKey(): string | null {
  for (const name of ["leoagent-local.key", "key"]) {
    try {
      const key = readFileSync(leoPath(name), "utf8").trim();
      if (key.length >= 16) return key;
    } catch {
      // 下一个
    }
  }
  return null;
}

const LEOAGENT_PUSHABLE = new Set([
  "approval.request",
  "run.completed",
  "run.failed",
  "run.cancelled",
]);

function sameSecret(a: string, b: string): boolean {
  const digest = (value: string) => createHash("sha256").update(value).digest();
  return timingSafeEqual(digest(a), digest(b));
}

/**
 * leoagent 切到桥接后自己不连中继,它的审批 / 完成事件 POST 到这里,借桥接这条连接推给手机。
 * 只认 leoagent 自己那把钥匙,只放行会推送的几类事件。
 */
export function forwardLeoagentEvent(
  authorization: string | undefined,
  event: unknown,
): 200 | 400 | 401 | 503 {
  const key = leoagentKey();
  if (!key || !sameSecret(authorization ?? "", `Bearer ${key}`)) return 401;
  if (!event || typeof event !== "object") return 400;
  const { event: name, session_id: sessionId } = event as Record<string, unknown>;
  if (typeof name !== "string" || !LEOAGENT_PUSHABLE.has(name)) return 400;
  if (typeof sessionId !== "string" || !sessionId.startsWith("hs_")) return 400;
  if (!running) return 503;
  running.pushEvent(event as HarnessEvent);
  return 200;
}

/** 正在跑的那条中继连接;「连接手机」面板读它的状态、借它的机器钥匙签配对码。 */
let running: RelayLink | null = null;
let directRunning: { grants: DirectGrants; device: LeoDeviceDescriptor; port: number } | null =
  null;
let directError: string | null = null;

export function createLeoDirectPairingCode(): {
  payload: string;
  exp: number;
  apiRoot: string;
  deviceId: string;
} {
  if (!directRunning) throw new Error("直连入口尚未启用");
  const endpoint = directRunning.device.endpoints.find((item) => item.kind === "direct")!;
  const code = directRunning.grants.createPairingCode();
  return {
    payload: "leoagent-direct:v1|" + JSON.stringify({ apiRoot: endpoint.baseURL, ...code }),
    exp: code.exp,
    apiRoot: endpoint.baseURL,
    deviceId: code.deviceId,
  };
}

export async function revokeLeoDirectDevice(deviceId: string): Promise<void> {
  if (!directRunning) throw new Error("直连入口尚未启用");
  await directRunning.grants.revoke(deviceId);
}

/** 中继支不支持出码:每次连上中继探一次(中继升级会断线重连,换代后重新探)。 */
let pairingProbe: { connectedAt: number; support: PairingSupport } | null = null;

function pairingSupport(state: RelayLinkStatus): PairingSupport {
  const raw = readRelayJson();
  if (!raw || !state.connected || state.connectedAt === null) return "unknown";
  if (pairingProbe?.connectedAt === state.connectedAt) return pairingProbe.support;
  const probe = { connectedAt: state.connectedAt, support: "unknown" as PairingSupport };
  pairingProbe = probe;
  void probePairingSupport(raw.url).then((support) => {
    probe.support = support;
  });
  return "unknown";
}

export type LeoLinkStatus = RelayLinkStatus & {
  enabled: boolean;
  configured: boolean;
  running: boolean;
  /** 中继能不能出配对码(老中继没有这个接口)。 */
  pairing: PairingSupport;
  machine: string;
  /** 只给主机名,不给路径和钥匙。 */
  relayHost: string | null;
  direct: {
    running: boolean;
    deviceId: string | null;
    baseURL: string | null;
    port: number | null;
    error: string | null;
    syncEnabled: boolean;
    treasuryEnabled: boolean;
    devices: { deviceId: string; name: string; expiresAt: number }[];
  };
};

export function leoLinkStatus(): LeoLinkStatus {
  const raw = readRelayJson();
  let relayHost: string | null = null;
  if (raw) {
    try {
      relayHost = new URL(relayHttpBase(raw.url)).host;
    } catch {
      relayHost = null;
    }
  }
  const state: RelayLinkStatus = running?.status() ?? {
    connected: false,
    relayVersion: null,
    connectedAt: null,
    lastError: null,
    lastErrorAt: null,
  };
  return {
    ...state,
    enabled: linkEnabled(),
    configured: Boolean(raw),
    running: Boolean(running),
    pairing: pairingSupport(state),
    machine: machineName(),
    relayHost,
    direct: {
      running: Boolean(directRunning),
      deviceId: directRunning?.device.deviceId ?? null,
      baseURL:
        directRunning?.device.endpoints.find((item) => item.kind === "direct")?.baseURL ?? null,
      port: directRunning?.port ?? null,
      error: directError,
      syncEnabled: directRunning?.device.capabilities.includes("sync-replica-v1") ?? false,
      treasuryEnabled: directRunning?.device.capabilities.includes("treasury-v1") ?? false,
      devices: directRunning?.grants.devices() ?? [],
    },
  };
}

/** 给新手机出一个一次性配对码。只在这台 Mac 的连接开着、而且连上中继时出码。 */
export async function createLeoPairingCode(): Promise<PairingCode> {
  const raw = readRelayJson();
  if (!raw) throw new Error("这台 Mac 还没配置中继(~/.leoagent/relay.json)");
  // 手机只接受 https 的中继根(见 iOS RelayPairPayload.parse)。
  if (!/^(https|wss):\/\//i.test(raw.url))
    throw new Error("中继地址不是 https,手机不会接受这个配对码");
  if (!running) throw new Error("手机连接没有开启");
  if (!running.status().connected) throw new Error("这台 Mac 现在没连上中继,稍后再试");
  const machineKey = await running.machineKey();
  return createPairingCode({
    relayUrl: raw.url,
    machine: machineName(),
    keys: machineKey ? [machineKey, raw.key] : [raw.key],
  });
}

/** 作废界面上一次出的码(传二维码整串)。 */
export async function revokeLeoPairingCode(payload: string): Promise<void> {
  const token = joinTokenFromPayload(payload);
  const raw = readRelayJson();
  if (payload.startsWith("leoagent-direct:v1|")) {
    try {
      directRunning?.grants.revokePairingCode(
        String(JSON.parse(payload.slice("leoagent-direct:v1|".length)).join ?? ""),
      );
    } catch {
      /* malformed QR is already unusable */
    }
    return;
  }
  if (!token || !raw) return;
  const machineKey = running ? await running.machineKey() : null;
  await revokePairingCode({
    relayUrl: raw.url,
    token,
    keys: machineKey ? [machineKey, raw.key] : [raw.key],
  });
}

/**
 * [leo-link] 手机经中继连回这台 Mac。只在抢到本机端口的那个 Host 里跑一份。
 * 返回 null 表示没开或没配中继。
 */
export async function startLeoLink(deps: {
  taskService: IZCodeTaskService;
  settingService?: ISettingService;
  logger: Logger;
  appVersion: string | null;
  treasuryStore?: TreasuryStore;
}): Promise<{ stop(): Promise<void> } | null> {
  if (!linkEnabled()) {
    deps.logger.info("[leo/link] disabled (~/.leoagent/link.json)");
    return null;
  }
  const relay = resolveRelayConfig();
  let direct: ReturnType<typeof directConfig> = null;
  directError = null;
  try {
    direct = directConfig(readJson(leoPath("link.json"))?.["direct"]);
  } catch {
    directError = "直连配置无效：需要 HTTPS Tailscale 域名和专用端口";
  }
  if (!relay && !direct) {
    deps.logger.info("[leo/link] no relay or direct endpoint configured");
    return null;
  }
  let link: RelayLink | null = null;
  let device: LeoDeviceDescriptor | undefined;
  try {
    device = leoDeviceDescriptorSchema.parse({
      schemaVersion: 1,
      deviceId: await loadDeviceIdentity(leoPath("link-device-identity.json")),
      name: relay?.name ?? machineName(),
      platform: process.platform === "darwin" ? "macos" : process.platform,
      capabilities: [
        "harness",
        "resumable-events",
        "approval-events",
        ...(direct ? ["direct-grants", "operation-receipts"] : []),
        ...(direct?.syncEnabled ? ["sync-replica-v1"] : []),
        ...(direct?.treasuryEnabled && deps.treasuryStore ? ["treasury-v1"] : []),
      ],
      aliases: [relay?.name ?? machineName()],
      endpoints: [
        ...(relay
          ? [
              {
                id: "relay",
                kind: "relay",
                baseURL: `${relayHttpBase(relay.wsUrl)}/relay/api/m/${encodeURIComponent(relay.name)}`,
              },
            ]
          : []),
        ...(direct ? [{ id: "direct", kind: "direct", baseURL: direct.baseURL }] : []),
      ],
    });
  } catch {
    // 身份文件损坏时保留旧中继，不静默换身份导致旧授权失联。
    deps.logger.warn("[leo/link] device identity unavailable; retaining legacy relay access");
  }
  let grants: DirectGrants | undefined;
  if (device) {
    grants = new DirectGrants(
      leoPath("link", "direct-grants.json"),
      device.deviceId,
      () => Date.now(),
      [
        "harness",
        ...(direct?.syncEnabled ? ["sync" as const] : []),
        ...(direct?.treasuryEnabled ? ["treasury" as const] : []),
      ],
    );
    // 损坏的授权表不能按空表启动，否则会复活已撤销设备。
    await grants.restore();
  }
  const bridge = new LinkBridge({
    device,
    directGrants: grants,
    taskService: deps.taskService,
    logger: deps.logger,
    push: (event) => link?.pushEvent(event),
    appVersion: deps.appVersion,
    journalDir: leoPath("link", "journals"),
    leoagent: { url: LEOAGENT_URL, key: leoagentKey },
    recentWorkspaces: async () => {
      const settings = await deps.settingService?.get();
      return (settings?.lastWorkspaceSession ?? [])
        .filter((entry) => entry.kind === "local")
        .map((entry) => entry.workspacePath);
    },
  });
  await bridge.restore();
  let directServer: Awaited<ReturnType<typeof startDirectServer>> | null = null;
  let replica: Awaited<ReturnType<typeof createSyncReplica>> | null = null;
  if (direct && grants && device) {
    try {
      if (direct.syncEnabled) replica = await createSyncReplica(leoPath("link", "sync-replica"));
      directServer = await startDirectServer({
        bridge,
        grants,
        device,
        port: direct.port,
        replicaHandler: replica?.handle,
        treasuryHandler:
          direct.treasuryEnabled && deps.treasuryStore
            ? createTreasuryHandler(deps.treasuryStore)
            : undefined,
      });
      directRunning = { grants, device, port: directServer.port };
    } catch {
      replica?.close();
      replica = null;
      directError = "直连无法启动，请检查端口冲突或副本存储";
      device.endpoints = device.endpoints.filter((item) => item.kind !== "direct");
    }
  }
  if (relay) {
    link = new RelayLink(
      relay,
      bridge,
      keychainMachineKeyStore(relay.name),
      deps.logger,
      deps.appVersion,
      device,
    );
    link.start();
    running = link;
  }
  deps.logger.info("[leo/link] started", {
    name: relay?.name ?? machineName(),
    direct: Boolean(directServer),
  });
  return {
    async stop() {
      if (running === link) running = null;
      link?.stop();
      directRunning = null;
      await directServer?.stop();
      replica?.close();
      await bridge.close();
    },
  };
}
