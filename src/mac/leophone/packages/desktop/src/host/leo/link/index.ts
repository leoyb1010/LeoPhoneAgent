import { existsSync, readFileSync } from "node:fs";
import os from "node:os";

import type { ISettingService, IZCodeTaskService } from "@zcode/services";

import { leoPath } from "../leoPaths.js";
import { LinkBridge } from "./bridge.js";
import { keychainMachineKeyStore, RelayLink, type RelayConfig } from "./relayLink.js";

type Logger = { info: (msg: string, meta?: unknown) => void; warn: (msg: string, meta?: unknown) => void };

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

/** 中继地址与注册钥匙:`~/.leoagent/relay.json {url, key}`,与 leoagent 共用。 */
export function resolveRelayConfig(): RelayConfig | null {
  const config = readJson(leoPath("relay.json"));
  const url = typeof config?.["url"] === "string" ? config["url"].trim() : "";
  const key = typeof config?.["key"] === "string" ? config["key"].trim() : "";
  if (!url || !key) return null;
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

/**
 * [leo-link] 手机经中继连回这台 Mac。只在抢到本机端口的那个 Host 里跑一份。
 * 返回 null 表示没开或没配中继。
 */
export async function startLeoLink(deps: {
  taskService: IZCodeTaskService;
  settingService?: ISettingService;
  logger: Logger;
  appVersion: string | null;
}): Promise<{ stop(): Promise<void> } | null> {
  if (!linkEnabled()) {
    deps.logger.info("[leo/link] disabled (~/.leoagent/link.json)");
    return null;
  }
  const relay = resolveRelayConfig();
  if (!relay) {
    deps.logger.info("[leo/link] no relay configured (~/.leoagent/relay.json)");
    return null;
  }
  let link: RelayLink | null = null;
  const bridge = new LinkBridge({
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
  link = new RelayLink(relay, bridge, keychainMachineKeyStore(relay.name), deps.logger, deps.appVersion);
  link.start();
  deps.logger.info("[leo/link] started", { name: relay.name });
  return {
    async stop() {
      link?.stop();
      await bridge.close();
    },
  };
}
