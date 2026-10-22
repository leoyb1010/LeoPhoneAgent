// [codex-sessions] 可接管的外部会话来源:Claude Code(~/.claude/projects)与 Codex(~/.codex,桌面版与 CLI 共用)。
// bridge 只经这里分流,两边的列表 / 查找 / 历史各在 externalSessions.ts、codexSessions.ts。
import { promises as fsp } from "node:fs";

import type { AcpAgentId } from "@zcode/shared/acp";

import { codexLockFile, codexLockHeld, defaultCodexHome, findCodexSession, listCodexSessions, readCodexHistory } from "./codexSessions.js";
import { defaultClaudeProjectsDir, type ExternalSession, findClaudeSession, listClaudeSessions, readClaudeHistory } from "./externalSessions.js";
import type { HarnessEvent } from "./journal.js";

export type ExternalAgent = ExternalSession["agent"];

export const EXTERNAL_AGENTS: Record<ExternalAgent, { acpId: AcpAgentId; name: string; where: string }> = {
  claude: { acpId: "claude-code", name: "Claude Code", where: "Mac 终端" },
  codex: { acpId: "codex", name: "Codex", where: "Mac 上的 Codex" },
};

export function isExternalAgent(value: unknown): value is ExternalAgent {
  return value === "claude" || value === "codex";
}

export type ExternalDirs = {
  claudeProjectsDir?: string;
  codexHome?: string;
  /** 测试注入:Codex 写锁是否真被某个进程持有(默认 lsof)。 */
  codexLockHeld?: (lockFile: string) => Promise<boolean>;
};

/** 两边的最近会话合在一起,按更新时间从新到旧。 */
export async function listExternalSessions(dirs: ExternalDirs): Promise<ExternalSession[]> {
  const [claude, codex] = await Promise.all([
    listClaudeSessions(dirs.claudeProjectsDir ?? defaultClaudeProjectsDir()),
    listCodexSessions(dirs.codexHome ?? defaultCodexHome()).catch(() => []),
  ]);
  return [...claude, ...codex].sort((a, b) => b.updated_at.localeCompare(a.updated_at));
}

export function findExternalSession(dirs: ExternalDirs, agent: ExternalAgent, id: string): Promise<ExternalSession | null> {
  return agent === "codex"
    ? findCodexSession(dirs.codexHome ?? defaultCodexHome(), id)
    : findClaudeSession(dirs.claudeProjectsDir ?? defaultClaudeProjectsDir(), id);
}

/**
 * Codex 打开着这个线程时持有写锁,LeoBot 的 codex-acp 拿不到锁就 resume 不了(会悄悄新开对话)。
 * 返回 true = 现在接管不了,先在 Mac 上关掉 Codex 里的这个任务。
 */
export async function externalLocked(dirs: ExternalDirs, session: ExternalSession): Promise<boolean> {
  if (session.agent !== "codex") return false;
  const lock = codexLockFile(dirs.codexHome ?? defaultCodexHome(), session.id);
  const exists = await fsp.stat(lock).then(() => true, () => false);
  return exists && (await (dirs.codexLockHeld ?? codexLockHeld)(lock));
}

export function readExternalHistory(session: ExternalSession): Promise<{ events: HarnessEvent[]; truncated: boolean }> {
  return session.agent === "codex" ? readCodexHistory(session.files ?? [session.file]) : readClaudeHistory(session.file);
}
