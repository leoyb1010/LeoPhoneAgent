// [fix-remote] 外部 agent 与内核 CLI 用 macOS 系统代理（node-only）。
// 这些 Mac 用 Clash 的「系统代理」（scutil --proxy 里 127.0.0.1:7897 一类），没有 TUN。LeoBot 由 launchd / Finder
// 启动时 env 里没有 HTTPS_PROXY，Node / Bun 写的 CLI（codex、gemini、opencode…）不读系统代理，连 OpenAI / Google
// 就一直挂着。这里把系统代理翻成 HTTP(S)_PROXY / ALL_PROXY / NO_PROXY 注入子进程；用户 env 里已有代理时一律不动。
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface SystemProxy {
  http?: string;
  https?: string;
  socks?: string;
}

// 100.64.0.0/10 是 Tailscale 的 CGNAT 段；只有 Go / curl / Python 认 CIDR，Node / Bun 这类只做后缀匹配的工具认不出，
// 它们靠 MagicDNS 名（.ts.net / *.ts.net 两种写法都给）绕开代理。中继域名不再写死，见 leoNoProxy()。
export const LEO_NO_PROXY = "localhost,127.0.0.1,::1,.local,*.local,100.64.0.0/10,.ts.net,*.ts.net";
/** 注入过的标记：设置关掉后，从已注入的环境再拉起子进程时能认出并撤掉。 */
export const LEO_PROXY_MARKER = "LEO_SYSTEM_PROXY_INJECTED";

const PROXY_KEYS = ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "ALL_PROXY", "all_proxy"] as const;
const NO_PROXY_KEYS = ["NO_PROXY", "no_proxy"] as const;

function field(output: string, key: string): string | undefined {
  return new RegExp(`^\\s*${key}\\s*:\\s*(\\S+)\\s*$`, "m").exec(output)?.[1];
}

/** 解析 `scutil --proxy` 的输出（只看启用了的 HTTP / HTTPS / SOCKS）。 */
export function parseScutilProxy(output: string): SystemProxy {
  const entry = (prefix: "HTTP" | "HTTPS" | "SOCKS", scheme: string): string | undefined => {
    if (field(output, `${prefix}Enable`) !== "1") return undefined;
    const host = field(output, `${prefix}Proxy`);
    const port = field(output, `${prefix}Port`);
    if (!host || !port || !/^\d+$/.test(port)) return undefined;
    return `${scheme}://${host.includes(":") ? `[${host}]` : host}:${port}`;
  };
  const out: SystemProxy = {};
  const http = entry("HTTP", "http");
  const https = entry("HTTPS", "http");
  const socks = entry("SOCKS", "socks5");
  if (http) out.http = http;
  if (https) out.https = https;
  if (socks) out.socks = socks;
  return out;
}

let cache: { at: number; proxy: SystemProxy } | undefined;
const CACHE_MS = 30_000;

/** 读系统代理（30 秒缓存：切换 Clash 的系统代理后下一次拉起子进程就跟上）。非 macOS 返回空。 */
export function readSystemProxy(now = Date.now()): SystemProxy {
  // 测试进程（scripts/test-isolation 设 LEO_SYSTEM_PROXY=off）不读本机代理，结果不随开发机变。
  if (process.platform !== "darwin" || process.env.LEO_SYSTEM_PROXY === "off") return {};
  if (cache && now - cache.at < CACHE_MS) return cache.proxy;
  let proxy: SystemProxy = {};
  try {
    proxy = parseScutilProxy(
      execFileSync("/usr/sbin/scutil", ["--proxy"], { encoding: "utf8", timeout: 2000, stdio: ["ignore", "pipe", "ignore"] }),
    );
  } catch {
    proxy = {};
  }
  cache = { at: now, proxy };
  return proxy;
}

/** 中继配置 `~/.leoagent/relay.json` 里的 url / phone_urls 的主机名（与 host/leo/link 读同一份文件）。 */
export function relayNoProxyHosts(env: NodeJS.ProcessEnv = process.env): string[] {
  const home = env.LEOAGENT_HOME?.trim() || join(env.HOME?.trim() || homedir(), ".leoagent");
  try {
    const config = JSON.parse(readFileSync(join(home, "relay.json"), "utf8")) as { url?: unknown; phone_urls?: unknown };
    const urls = [config.url, ...(Array.isArray(config.phone_urls) ? config.phone_urls : [])];
    const hosts = new Set<string>();
    for (const url of urls) {
      if (typeof url !== "string" || !url.trim()) continue;
      try {
        hosts.add(new URL(url.trim()).hostname);
      } catch {
        // 写坏的地址跳过
      }
    }
    return [...hosts];
  } catch {
    return [];
  }
}

/** 注入用的 NO_PROXY：固定的本机 / 局域网 / Tailscale 段 + 当前中继主机。 */
export function leoNoProxy(env: NodeJS.ProcessEnv = process.env): string {
  return [LEO_NO_PROXY, ...relayNoProxyHosts(env)].join(",");
}

function dataRoot(env: NodeJS.ProcessEnv): string {
  return env.ZCODE_HOME?.trim() || join(env.HOME?.trim() || homedir(), ".leophoneagent");
}

function settingsPath(env: NodeJS.ProcessEnv): string {
  return join(dataRoot(env), "acp", "settings.json");
}

/** 设置页「外部 agent 使用系统代理」，默认开。 */
export function systemProxyEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.LEO_SYSTEM_PROXY === "off") return false;
  try {
    const parsed = JSON.parse(readFileSync(settingsPath(env), "utf8")) as { systemProxy?: unknown };
    return parsed.systemProxy !== false;
  } catch {
    return true;
  }
}

export function setSystemProxyEnabled(enabled: boolean, env: NodeJS.ProcessEnv = process.env): void {
  const file = settingsPath(env);
  let current: Record<string, unknown> = {};
  try {
    current = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  } catch {
    current = {};
  }
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, JSON.stringify({ ...current, systemProxy: enabled }, null, 2), { mode: 0o600 });
}

/** 撤掉上次注入的那份；NO_PROXY 只在是我们写的（以 LEO_NO_PROXY 开头）时才撤，用户自己的保留。 */
function stripInjected(out: Record<string, string | undefined>): void {
  for (const key of [...PROXY_KEYS, LEO_PROXY_MARKER]) delete out[key];
  for (const key of NO_PROXY_KEYS) if (out[key]?.startsWith(LEO_NO_PROXY)) delete out[key];
}

/**
 * 给子进程的 env：用户已经设了 HTTP(S)_PROXY / ALL_PROXY 就原样返回；否则按系统代理补上
 * HTTP_PROXY / HTTPS_PROXY / ALL_PROXY（大小写两份）与 NO_PROXY。开关关掉时撤掉之前注入的那份。
 */
export function withSystemProxy(
  env: Record<string, string | undefined>,
  options: { enabled?: boolean; proxy?: SystemProxy } = {},
): Record<string, string | undefined> {
  const out = { ...env };
  const injected = out[LEO_PROXY_MARKER] === "1";
  const enabled = options.enabled ?? systemProxyEnabled(env as NodeJS.ProcessEnv);
  if (!enabled) {
    if (injected) stripInjected(out);
    return out;
  }
  // 带注入标记说明代理是我们上次补的：先撤掉旧值再按当前系统代理重补，Clash 退出 / 换端口后下次拉起子进程就跟上
  // （以前有标记就原样返回，换代理得重启 LeoBot）。
  if (injected) stripInjected(out);
  else if (PROXY_KEYS.some((key) => out[key]?.trim())) return out;
  const proxy = options.proxy ?? readSystemProxy();
  const web = proxy.https ?? proxy.http;
  const all = proxy.socks ?? web;
  if (!web && !all) return out;
  if (web) {
    out.HTTPS_PROXY = out.https_proxy = web;
    out.HTTP_PROXY = out.http_proxy = proxy.http ?? web;
  }
  if (all) out.ALL_PROXY = out.all_proxy = all;
  if (!NO_PROXY_KEYS.some((key) => out[key]?.trim())) out.NO_PROXY = out.no_proxy = leoNoProxy(env as NodeJS.ProcessEnv);
  out[LEO_PROXY_MARKER] = "1";
  return out;
}

/** 只取要补的那几项（给「在 process.env 之上叠加 env」的启动方式用，如内核 CLI）。 */
export function systemProxyAdditions(
  env: Record<string, string | undefined> = process.env,
  options: { enabled?: boolean; proxy?: SystemProxy } = {},
): Record<string, string> {
  const next = withSystemProxy(env, options);
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(next)) {
    if (typeof value === "string" && env[key] !== value) out[key] = value;
  }
  return out;
}
