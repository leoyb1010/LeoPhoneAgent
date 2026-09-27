import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * [leo] LeoPhoneAgent 自有数据目录。与 ZCode 的 `~/.zcode/v2` 分开:
 * 藏宝阁与手机连接是我们自己的东西,跟着上游同步走会被覆盖。
 * 2.x 已经在用这个目录,升级上来配对信息不用重配。
 */
export const LEO_HOME = process.env["LEOAGENT_HOME"]?.trim() || join(homedir(), ".leoagent");

export function leoPath(...parts: string[]): string {
  return join(LEO_HOME, ...parts);
}

export function ensureLeoHome(): void {
  if (!existsSync(LEO_HOME)) mkdirSync(LEO_HOME, { recursive: true, mode: 0o700 });
}

/**
 * 本机 HTTP 接口的 Bearer key。沿用 2.x 的 `~/.leoagent/key`:
 * 藏宝阁 MCP 子进程用它调本机接口,别的进程读不到这个文件就进不来。
 */
export function leoLocalKey(): string {
  const envKey = process.env["LEOAGENT_KEY"]?.trim();
  if (envKey) return envKey;
  ensureLeoHome();
  const keyFile = leoPath("key");
  if (existsSync(keyFile)) {
    const existing = readFileSync(keyFile, "utf8").trim();
    if (existing.length >= 16) return existing;
  }
  const generated = randomBytes(24).toString("base64url");
  writeFileSync(keyFile, `${generated}\n`, { mode: 0o600 });
  return generated;
}

/**
 * 藏宝阁 MCP 专用钥匙:只能调 `/api/leo/treasury/*`。写进 `~/.agents/mcp.json` 的是它,
 * 不是上面那把主钥匙 —— 那个文件所有 agent 都读得到。
 */
export function leoTreasuryKey(): string {
  ensureLeoHome();
  const keyFile = leoPath("treasury.key");
  if (existsSync(keyFile)) {
    const existing = readFileSync(keyFile, "utf8").trim();
    if (existing.length >= 16) return existing;
  }
  const generated = randomBytes(24).toString("base64url");
  writeFileSync(keyFile, `${generated}\n`, { mode: 0o600 });
  return generated;
}

/**
 * 出配对码的口令,由主进程每次启动随机生成、经 fork 环境传进来。模块加载时就从环境里
 * 抹掉:Host 起的 agent / 终端子进程继承不到它。
 */
const PAIR_SECRET = process.env["LEO_PAIR_SECRET"]?.trim() ?? "";
delete process.env["LEO_PAIR_SECRET"];

export function leoPairSecret(): string {
  return PAIR_SECRET;
}

/** 本机接口端口。2.x 用的是 38473,沿用它,藏宝阁 MCP 的默认地址不用改。 */
export const LEO_HTTP_PORT = Number(process.env["LEOAGENT_PORT"]) || 38473;
