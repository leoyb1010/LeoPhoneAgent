/**
 * Claude Code 本地会话存储(~/.claude/projects)的路径与查找工具。
 *
 * Claude Code CLI 按「会话 cwd 的 sanitize 转码」为目录名存放会话转录:
 *   <projectsRoot>/<sanitize(cwd)>/<sdkSessionId>.jsonl
 * resume / fork 都按当前 cwd 计算同一转码目录查找转录。fork-jsonl-repair(rewind
 * fork 修复)与 transcript-relocation(会话移动时迁移转录)共享这套路径逻辑,
 * 规则必须与 CLI 实现保持一致,集中在本文件维护。
 */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * CLI 对超长 cwd 的转码 key 会追加私有 hash,本侧无法复算。超过该长度时:
 * 查找侧可以用前缀 + 全目录扫描兜底;写入侧(迁移)则放弃,避免写错目录。
 */
export const PROJECT_KEY_MAX_LENGTH = 200;

/** 把会话 cwd 转成 Claude CLI 的 projects 子目录名(超长截断,供查找侧使用)。 */
export function sanitizeClaudeProjectKey(cwd: string): string {
  const key = cwd.replace(/[^a-zA-Z0-9]/g, '-');
  // Claude SDK appends a private hash for longer paths. Lookup callers fall
  // back to scanning all project dirs, so a prefix is enough for direct lookup.
  return key.length <= PROJECT_KEY_MAX_LENGTH ? key : key.slice(0, PROJECT_KEY_MAX_LENGTH);
}

/** cwd 是否超出可精确复算转码 key 的长度(超出则写入侧无法定位目标目录)。 */
export function isClaudeProjectKeyExact(cwd: string): boolean {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-').length <= PROJECT_KEY_MAX_LENGTH;
}

/** 解析 Claude CLI 配置目录下的 projects 根目录(尊重 CLAUDE_CONFIG_DIR 重定向)。 */
export function resolveClaudeProjectsRoot(): string {
  const claudeConfigDir = process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), '.claude');
  return path.join(claudeConfigDir, 'projects');
}

/** realpath + NFC 归一化;路径不存在时退回原值归一化(与 CLI 对 cwd 的处理对齐)。 */
export async function normalizedExistingPath(input: string): Promise<string> {
  try {
    return (await fs.realpath(input)).normalize('NFC');
  } catch {
    return input.normalize('NFC');
  }
}

/** 列出 projects 根目录下所有项目子目录(全局扫描兜底用)。 */
export async function listProjectDirs(projectsRoot: string): Promise<string[]> {
  const entries = await fs.readdir(projectsRoot, { withFileTypes: true }).catch(() => []);
  return entries
    .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
    .map((entry) => path.join(projectsRoot, entry.name));
}

/**
 * 按 sdkSessionId 查找会话转录 jsonl:优先 workingDir 的转码目录直接命中
 * (它是最近一次移动 / 写入的目标,语义上最权威),找不到再全目录扫描
 * (覆盖转码 key 截断 / cwd 已变更的历史文件)。
 * 找不到返回 null,由调用方决定是报错(fork 修复)还是跳过(迁移)。
 */
export async function findClaudeSessionJsonl(
  sessionId: string,
  workingDir: string | undefined,
  projectsRoot: string,
): Promise<string | null> {
  const filename = `${sessionId}.jsonl`;

  if (workingDir) {
    const normalized = await normalizedExistingPath(workingDir);
    const directKey = sanitizeClaudeProjectKey(normalized);
    const directPath = path.join(projectsRoot, directKey, filename);
    const directStat = await fs.stat(directPath).catch(() => null);
    if (directStat?.isFile() && directStat.size > 0) return directPath;
  }

  // 全目录扫描兜底:迁移是复制不删源,多次移动后多个目录可能都留有同名副本,
  // 必须按 mtime 取最新——按目录枚举顺序取第一个会把过期副本当作源复制到目标,
  // resume 丢移动后新增的轮次(PR #472 Greptile review 指出)。
  let best: { path: string; mtimeMs: number } | null = null;
  for (const projectDir of await listProjectDirs(projectsRoot)) {
    const candidate = path.join(projectDir, filename);
    const stat = await fs.stat(candidate).catch(() => null);
    if (!stat?.isFile() || stat.size <= 0) continue;
    if (!best || stat.mtimeMs > best.mtimeMs) {
      best = { path: candidate, mtimeMs: stat.mtimeMs };
    }
  }
  return best?.path ?? null;
}
