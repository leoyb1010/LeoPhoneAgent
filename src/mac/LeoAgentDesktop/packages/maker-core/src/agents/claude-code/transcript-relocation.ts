/**
 * Claude Code 会话转录迁移(会话移动 / workingDir 变更时)。
 *
 * 背景:CLI 的 resume / rewind-fork 都按「当前 cwd 的转码目录」查找转录 jsonl
 * (见 claude-projects-fs.ts)。xdt-maker 里会话的 workingDir 可被用户改变
 * (对话移动到项目、移回对话、换项目目录),只更新 DB 不搬转录的话,下一次
 * resume 会因 CLI 在新 cwd 转码目录下找不到 jsonl 而报
 * "No conversation found with session ID: ..."。
 *
 * 本模块在 workingDir 变更后,把会话相关的全部 sdk session 转录**复制**到新
 * cwd 的转码目录。选复制不选移动:源文件保留意味着操作可重入、可再次移动、
 * 出错时不丢历史;CLI 对重复文件按目录隔离互不影响。
 *
 * 除会话移动外,ensureClaudeTranscriptInWorkingDir 基于同一套路径工具做「归位」:
 * resume spawn 前与 rewind fork 后,确保会话 workingDir 转码目录里是该 sdk session
 * 的最新转录副本(覆盖 CLI 运行中 cd、fork jsonl 落在源文件旁等 DB workingDir
 * 未变的分叉场景;与迁移不同,归位始终全局扫描比 mtime,不被目标直查短路)。
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';

import {
  findClaudeSessionJsonl,
  isClaudeProjectKeyExact,
  normalizedExistingPath,
  resolveClaudeProjectsRoot,
  sanitizeClaudeProjectKey,
} from './claude-projects-fs.js';

export interface RelocateClaudeTranscriptsOptions {
  /** 待迁移的 sdk session id 集合(自动去重;空集为 no-op)。 */
  sdkSessionIds: string[];
  /** 变更前的会话 workingDir,用于源转录的直接定位(找不到时全局扫描兜底)。 */
  oldWorkingDir: string;
  /** 变更后的会话 workingDir,决定目标转码目录。 */
  newWorkingDir: string;
  /** 测试注入用;缺省为 CLAUDE_CONFIG_DIR(或 ~/.claude)下的 projects。 */
  projectsRoot?: string;
}

export interface RelocateClaudeTranscriptsResult {
  /** 目标不存在、本次新复制到新目录的 sdk session id。 */
  copied: string[];
  /** 目标已存在但比源旧(往返移动场景的过期副本)、被源覆盖刷新的 sdk session id。 */
  replaced: string[];
  /** 目标已存在且不旧于源、按已就位跳过的 sdk session id。 */
  skipped: string[];
  /** 源转录找不到(从未落盘 / 已被清理)的 sdk session id。 */
  missing: string[];
  /** 新 workingDir 转码 key 超长、无法精确定位目标目录时为 true(此时不做任何复制)。 */
  targetKeyInexact: boolean;
}

/**
 * 把 sdkSessionIds 对应的转录从旧 cwd 转码目录复制到新 cwd 转码目录。
 * 单个 id 的失败(源缺失)不影响其余 id;文件系统错误(权限、磁盘)向上抛出,
 * 由调用方决定日志级别——迁移是 best-effort 增强,不应阻断会话移动主流程。
 */
export async function relocateClaudeSessionTranscripts(
  options: RelocateClaudeTranscriptsOptions,
): Promise<RelocateClaudeTranscriptsResult> {
  const projectsRoot = options.projectsRoot ?? resolveClaudeProjectsRoot();
  const result: RelocateClaudeTranscriptsResult = {
    copied: [],
    replaced: [],
    skipped: [],
    missing: [],
    targetKeyInexact: false,
  };

  // typeof 防御:调用方拼装的集合可能混入非字符串(如坏 meta 行),这里是最后一道闸。
  const uniqueIds = [...new Set(options.sdkSessionIds)].filter(
    (id) => typeof id === 'string' && id.trim().length > 0,
  );
  if (uniqueIds.length === 0) return result;

  const newNormalized = await normalizedExistingPath(options.newWorkingDir);
  // CLI 对超长 cwd 的转码 key 带私有 hash,本侧复算不出;写错目录比不写更糟,放弃。
  if (!isClaudeProjectKeyExact(newNormalized)) {
    result.targetKeyInexact = true;
    return result;
  }
  const targetDir = path.join(projectsRoot, sanitizeClaudeProjectKey(newNormalized));

  let targetDirEnsured = false;
  for (const sdkSessionId of uniqueIds) {
    const sourceFile = await findClaudeSessionJsonl(sdkSessionId, options.oldWorkingDir, projectsRoot);
    if (!sourceFile) {
      result.missing.push(sdkSessionId);
      continue;
    }
    const targetFile = path.join(targetDir, `${sdkSessionId}.jsonl`);
    if (sourceFile === targetFile) {
      result.skipped.push(sdkSessionId);
      continue;
    }
    if (!targetDirEnsured) {
      await fs.mkdir(targetDir, { recursive: true });
      targetDirEnsured = true;
    }
    // 目标已存在时按 mtime 决定去留:往返移动(A→B 聊过再移回 A)后旧目录里是
    // 过期副本,源更新则必须覆盖刷新,否则 resume 读到旧内容丢中间轮次;
    // 目标不旧于源(重复移动、无新内容的往返)则保持不动。
    const targetStat = await fs.stat(targetFile).catch(() => null);
    if (!targetStat) {
      await fs.copyFile(sourceFile, targetFile);
      result.copied.push(sdkSessionId);
      continue;
    }
    const sourceStat = await fs.stat(sourceFile);
    if (sourceStat.mtimeMs > targetStat.mtimeMs) {
      await fs.copyFile(sourceFile, targetFile);
      result.replaced.push(sdkSessionId);
    } else {
      result.skipped.push(sdkSessionId);
    }
  }

  return result;
}

export type EnsureClaudeTranscriptOutcome =
  /** workingDir 转码目录内的转录已是全局最新副本,未做任何复制。 */
  | 'in-place'
  /** 在其它转码目录找到更新(或目标缺失时的唯一)副本并复制归位。 */
  | 'restored'
  /** 所有转码目录都找不到该转录(CLI resume 将按原行为报错)。 */
  | 'missing'
  /** workingDir 转码 key 超长无法精确定位目标目录,放弃归位。 */
  | 'target-key-inexact';

export interface EnsureClaudeTranscriptOptions {
  /** 需要归位的 sdk session id。 */
  sdkSessionId: string;
  /** CLI 子进程将使用的 cwd(会话 workingDir),决定目标转码目录。 */
  workingDir: string;
  /** 测试注入用;缺省为 CLAUDE_CONFIG_DIR(或 ~/.claude)下的 projects。 */
  projectsRoot?: string;
}

/**
 * 转录就位兜底:确保 workingDir 转码目录里的转录是该 sdk session 的**最新**副本。
 *
 * CLI 的 resume 只查「当前 cwd 的转码目录」,而转录可能因以下场景落在别处:
 *   - CLI 进程运行中 cd(worktree 工作流等)后新建的 sdk session,转录落在
 *     新 cwd 的转码目录,DB workingDir 却没变,会话移动迁移不会触发;
 *   - rewind fork:SDK forkSession 把新 jsonl 写在源转录旁边,源在哪新的就在哪
 *     (2026-07-05 实测事故:fork 落在已删除 worktree 的孤儿转码目录,随后
 *     resume 报 "No conversation found with session ID")。
 * 与会话移动迁移不同,这里**始终全局扫描**、按 mtime 与目标比较——目标目录里躺着
 * 旧副本而 CLI 在别的 cwd 下继续写同一 sdk session 时(cwd 漂移的另一半形态),
 * 直查命中即返回会让 resume 读到过期内容丢轮次(PR #624 Codex review 指出)。
 * 成本:一次 readdir + 每转码目录一次 stat,仅发生在 session spawn 前,非热路径。
 */
export async function ensureClaudeTranscriptInWorkingDir(
  options: EnsureClaudeTranscriptOptions,
): Promise<EnsureClaudeTranscriptOutcome> {
  const projectsRoot = options.projectsRoot ?? resolveClaudeProjectsRoot();
  const normalized = await normalizedExistingPath(options.workingDir);
  // CLI 对超长 cwd 的转码 key 带私有 hash,本侧复算不出;写错目录比不写更糟,放弃。
  if (!isClaudeProjectKeyExact(normalized)) return 'target-key-inexact';
  const targetFile = path.join(
    projectsRoot,
    sanitizeClaudeProjectKey(normalized),
    `${options.sdkSessionId}.jsonl`,
  );

  // workingDir 传 undefined 跳过直查短路,强制全局扫描按 mtime 取最新(含目标自身)。
  const newestFile = await findClaudeSessionJsonl(options.sdkSessionId, undefined, projectsRoot);
  if (!newestFile) return 'missing';
  if (newestFile === targetFile) return 'in-place';

  const targetStat = await fs.stat(targetFile).catch(() => null);
  // 目标不存在,或严格旧于全局最新副本(mtime 相同视为等价,不做无谓覆盖)→ 归位。
  if (targetStat) {
    const newestStat = await fs.stat(newestFile);
    if (newestStat.mtimeMs <= targetStat.mtimeMs) return 'in-place';
  }
  await fs.mkdir(path.dirname(targetFile), { recursive: true });
  await fs.copyFile(newestFile, targetFile);
  return 'restored';
}
