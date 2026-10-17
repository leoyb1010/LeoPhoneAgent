// [fix-remote] 手机远程用 Mac 的两件辅助：SSH 兜底的目标、外部 agent 的远程登录。
// 手机的 SSH 兜底要连哪台、用哪个用户：从 `tailscale status --self --json` 的 MagicDNS 名与当前用户名得出，
// 经 capabilities 广播（iOS 优先用它，其次用设置里的默认映射）。读不到 tailscale 就不广播。
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import os from "node:os";

import type { AcpAgentId } from "@zcode/shared/acp";
import { AcpLoginFlows, acpAuthState, nodePtyLoginSpawner, type AcpAuthState, type NodePtyLike } from "@zcode/shared/acp-login";

export interface SshTarget {
  host: string;
  user: string;
  /** 完整的 MagicDNS 名（带 tailnet 后缀），手机不在同一 search domain 时用它。 */
  fqdn?: string;
}

/** 解析 `tailscale status --self --json`：Self.DNSName = "leomac-studio.tail23de22.ts.net."。 */
export function parseTailscaleSelf(json: string, user: string): SshTarget | null {
  try {
    const parsed = JSON.parse(json) as { Self?: { DNSName?: unknown } };
    const dns = typeof parsed.Self?.DNSName === "string" ? parsed.Self.DNSName.replace(/\.$/, "") : "";
    const host = dns.split(".")[0] ?? "";
    if (!host || !/^[a-z0-9-]{1,63}$/i.test(host) || !/^[a-z_][a-z0-9_.-]{0,63}$/i.test(user)) return null;
    return { host, user, fqdn: dns };
  } catch {
    return null;
  }
}

const TAILSCALE_PATHS = ["/usr/local/bin/tailscale", "/opt/homebrew/bin/tailscale", "/Applications/Tailscale.app/Contents/MacOS/Tailscale"];
let cache: { at: number; value: SshTarget | null } | undefined;

export function readSshTarget(now = Date.now()): Promise<SshTarget | null> {
  if (cache && now - cache.at < 10 * 60_000) return Promise.resolve(cache.value);
  const cli = TAILSCALE_PATHS.find((candidate) => existsSync(candidate));
  if (!cli) return Promise.resolve(null);
  return new Promise((resolve) => {
    execFile(cli, ["status", "--self", "--json"], { timeout: 3000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => {
      const value = error ? null : parseTailscaleSelf(stdout, os.userInfo().username);
      cache = { at: now, value };
      resolve(value);
    });
  });
}

/**
 * [fix-remote] 远程登录外部 agent 的流程表：node-pty 让 claude 能回填授权码；加载不了就退回 script(1)
 * （设备码流程照样能用）。
 */
export async function createAgentLogin(): Promise<{
  state: (id: AcpAgentId) => AcpAuthState;
  flows: AcpLoginFlows;
}> {
  const spawnLogin = await import("node-pty").then(
    (pty) => nodePtyLoginSpawner(pty as unknown as NodePtyLike),
    () => undefined,
  );
  return { state: (id) => acpAuthState(id), flows: new AcpLoginFlows(spawnLogin ? { spawnLogin } : {}) };
}
