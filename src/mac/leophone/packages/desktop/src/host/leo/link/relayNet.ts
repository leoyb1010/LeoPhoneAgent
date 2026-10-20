import dns from "node:dns";
import type { LookupFunction } from "node:net";
import os from "node:os";

/** [leo-link] 中继长连接用到的网络辅助：tailnet 解析、睡眠唤醒 / 换网检测。 */

const TAILNET_DNS = "100.100.100.100";
const SYSTEM_WATCH_MS = 5_000;
/** 两次 5 秒心跳之间隔了超过这么久，说明机器睡过（定时器在睡眠里不走）。 */
const WAKE_GAP_MS = 20_000;

/** 网卡地址指纹（不含回环）；换 Wi-Fi、插拔网线、开关 VPN 都会变。 */
export function networkSignature(interfaces: NodeJS.Dict<os.NetworkInterfaceInfo[]> = os.networkInterfaces()): string {
  const addresses: string[] = [];
  for (const [name, infos] of Object.entries(interfaces)) {
    for (const info of infos ?? []) if (!info.internal) addresses.push(`${name}/${info.address}`);
  }
  return addresses.sort().join(",");
}

/**
 * [leo] 睡眠唤醒 / 换网检测。Host 是 utilityProcess，拿不到 Electron 的 powerMonitor（只在 main），
 * 所以用「定时器停摆」判断唤醒、用网卡指纹判断换网；每次 check() 返回这一拍发生了什么。
 */
export function systemChangeDetector(
  read: () => { now: number; network: string },
  wakeGapMs = WAKE_GAP_MS,
): () => "wake" | "network" | null {
  let last = read();
  return () => {
    const next = read();
    const woke = next.now - last.now > wakeGapMs;
    const moved = next.network !== last.network;
    last = next;
    return woke ? "wake" : moved ? "network" : null;
  };
}

/**
 * tailnet 域名(`*.ts.net`)用 Tailscale 自己的 DNS 解析。本机开着代理(Clash TUN)时,系统解析
 * 会给出代理的假 IP,和中继之间的常驻连接就绕到代理节点上:实测每个来回 2~3 秒,直连 tailnet 只要
 * 几十毫秒。解析不到(没开 Tailscale、不是 tailnet 域名)就退回系统解析。
 */
export function tailnetLookup(servers: string[] = [TAILNET_DNS]): LookupFunction {
  const resolver = new dns.Resolver({ timeout: 1500, tries: 1 });
  resolver.setServers(servers);
  return ((
    hostname: string,
    options: dns.LookupOptions,
    callback: (...args: unknown[]) => void,
  ) => {
    const fallback = () => dns.lookup(hostname, options, callback as never);
    if (!hostname.endsWith(".ts.net")) return fallback();
    resolver.resolve4(hostname, (error, addresses) => {
      if (error || addresses.length === 0) return fallback();
      if (options.all)
        callback(
          null,
          addresses.map((address) => ({ address, family: 4 })),
        );
      else callback(null, addresses[0], 4);
    });
  }) as LookupFunction;
}

/** 每 5 秒看一眼：机器睡过或网卡地址变了就回调；返回停止函数。 */
export function watchSystemChanges(onChange: (change: "wake" | "network") => void): () => void {
  const check = systemChangeDetector(() => ({ now: Date.now(), network: networkSignature() }));
  const timer = setInterval(() => {
    const change = check();
    if (change) onChange(change);
  }, SYSTEM_WATCH_MS);
  timer.unref();
  return () => clearInterval(timer);
}
