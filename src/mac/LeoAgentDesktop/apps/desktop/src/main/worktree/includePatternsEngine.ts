/**
 * worktree-parallel-sessions: `.xdtworktreeinclude` 解析与拷贝引擎。
 *
 * 文件位于 baseRepo 根目录, 内容是按行的 glob pattern。worktree 创建后, 把匹配
 * 的(且 git 不跟踪的)文件按相对路径复制到 worktree 路径下, 用于带过去
 * .env / 本地 build 产物 / IDE 配置等不入库的本地文件。
 *
 * 规则:
 *   - 每行 trim
 *   - 跳过空行 + `#` 开头注释
 *   - 其余作为 glob(支持 `*` `**` `?` 和绝对路径不支持, 仅 baseRepo 相对)
 *   - per file 状态:
 *       skipped-not-exist | skipped-tracked | skipped-existing | copied | copied-symlink | failed
 *
 * 不依赖外部 glob 库——用 node:fs.readdirSync 递归 + 自实现简单 glob match。
 */

import path from 'node:path';
import fs from 'node:fs';
import { MANAGED_WORKTREE_DIR_NAMES } from '../../shared/managedWorktreePaths';

import { gitExec } from './gitExec';

export type IncludeFileStatus =
  | 'skipped-not-exist'
  | 'skipped-tracked'
  | 'skipped-existing'
  | 'skipped-outside'
  | 'copied'
  | 'copied-symlink'
  | 'failed';

export interface CopyWorktreeIncludeOptions {
  /** 默认覆盖目标；恢复脏快照后可关闭，避免覆盖刚还原的未跟踪文件。 */
  overwriteExisting?: boolean;
}

export interface IncludeFileResult {
  /** baseRepo 相对路径(用 / 分隔, 跨平台一致)。 */
  relpath: string;
  status: IncludeFileStatus;
  error?: string;
}

export interface ChangedIncludeFile {
  relpath: string;
  reason:
    | 'missing'
    | 'type-mismatch'
    | 'content-differs'
    | 'symlink-differs'
    | 'outside'
    /** 只存在于 worktree、base 侧没有的 include 匹配文件（删除会丢，无法从 base 重拷）。 */
    | 'dest-only';
}

/**
 * 解析 `.xdtworktreeinclude` 内容, 返回去重后的 pattern 列表。
 * 该函数不读文件——上层先 read 再传给本函数, 便于测试。
 */
export function parseWorktreeIncludePatterns(content: string): string[] {
  if (!content) return [];
  const lines = content.split(/\r?\n/);
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of lines) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith('#')) continue;
    if (seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

/**
 * 把 glob pattern 转为 RegExp。仅支持基本通配:
 *   *  → [^/]*
 *   ** → .*
 *   ?  → [^/]
 *   其他字符按字面 escape
 *
 * 测试覆盖在 nameGenerator 隔壁的 includePatternsEngine.test.ts。
 */
function globToRegex(glob: string): RegExp {
  // 占位 `**/` 与孤立 `**` 区分开:
  //   `**/foo`   ⇔ 0 或多段目录 + foo  → `(?:.*\/)?foo`
  //   `foo/**`   ⇔ foo/ 下任意路径 + 任意子项 → `foo\/.*`
  //   `a/**/b`   ⇔ 中段 0+ 目录          → `a(?:\/.*)?\/b`
  //   单 `*`     ⇔ 单段不跨 /            → `[^/]*`
  //   单 `?`     ⇔ 单字符不跨 /          → `[^/]`
  //
  // 实现: 先把 `**/` 和 `/**` 替换为占位, 再转义其他字符, 最后还原占位。
  const PH_LEADING = '\u0000DSL\u0000'; // **/ at start
  const PH_TRAILING = '\u0000DST\u0000'; // /** at end / inline
  const PH_BARE = '\u0000DSB\u0000'; // ** alone (无 /)
  let p = glob;
  // 处理顺序: trailing `/**` → leading `**/` → bare `**`
  p = p.replace(/\/\*\*/g, PH_TRAILING);
  p = p.replace(/\*\*\//g, PH_LEADING);
  p = p.replace(/\*\*/g, PH_BARE);
  // 转义正则元字符
  p = p.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  // 单星 → 不跨 / 的任意字符
  p = p.replaceAll('*', '[^/]*');
  // 单 ? → 不跨 / 的单字符
  p = p.replaceAll('?', '[^/]');
  // 还原占位:
  //   `**/`  → `(?:.*\/)?` 0 或多段(含尾 /)
  //   `/**`  → `(?:\/.*)?` 0 或多段(含头 /)
  //   `**`   → `.*`
  p = p.replaceAll(PH_LEADING, '(?:.*\\/)?');
  p = p.replaceAll(PH_TRAILING, '(?:\\/.*)?');
  p = p.replaceAll(PH_BARE, '.*');
  return new RegExp(`^${p}$`);
}

/**
 * 递归列出 baseRepo 下的所有文件相对路径(用 / 分隔)。
 * 跳过 .git/ + node_modules/ + Cindy 当前/历史托管 worktree 子树, 防止扫超量。
 */
function listAllFiles(baseRepo: string): string[] {
  const out: string[] = [];
  const SKIP_TOP = new Set(['.git', 'node_modules', ...MANAGED_WORKTREE_DIR_NAMES]);
  function walk(absDir: string, relDir: string): void {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(absDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      // 仅在顶层过滤 SKIP_TOP, 子目录里同名仍允许(罕见但合理)
      if (relDir === '' && SKIP_TOP.has(ent.name)) continue;
      const childRel = relDir ? `${relDir}/${ent.name}` : ent.name;
      const childAbs = path.join(absDir, ent.name);
      if (ent.isDirectory()) {
        walk(childAbs, childRel);
      } else if (ent.isFile() || ent.isSymbolicLink()) {
        out.push(childRel);
      }
    }
  }
  walk(baseRepo, '');
  return out;
}

/**
 * 用 git ls-files --error-unmatch 判断每个相对路径是否被 git tracked。
 * 一次批量调用比每条 spawn 一遍 git 快 O(N) 倍。
 *
 * 返回的 Set 元素是 baseRepo 相对路径(/ 分隔)。
 */
async function getTrackedFiles(baseRepo: string): Promise<Set<string>> {
  try {
    const { stdout } = await gitExec(['ls-files'], baseRepo);
    const set = new Set<string>();
    for (const line of stdout.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (trimmed) set.add(trimmed);
    }
    return set;
  } catch {
    // 失败时给空集合, 让调用方按 "都不被 tracked" 处理(更安全的兜底)
    return new Set<string>();
  }
}

/**
 * 把 baseRepo 下匹配 patterns 且未被 git tracked 的文件拷贝到 destRoot 下相同相对路径。
 *
 * 已存在的 dest 文件会被覆盖(fs.copyFile 默认行为)。软链复制为软链本身。
 *
 * @param baseRepo  源 repo 根目录(绝对路径)
 * @param destRoot  目标 worktree 路径(绝对路径)
 * @param patterns  parseWorktreeIncludePatterns 的输出
 * @returns per-file 结果, 用于日志 / UI 展示
 */
export async function copyWorktreeIncludeFiles(
  baseRepo: string,
  destRoot: string,
  patterns: readonly string[],
  options: CopyWorktreeIncludeOptions = {},
): Promise<IncludeFileResult[]> {
  if (patterns.length === 0) return [];
  const regexes = patterns.map(globToRegex);
  const allFiles = listAllFiles(baseRepo);
  const matched: string[] = [];
  for (const rel of allFiles) {
    if (regexes.some((re) => re.test(rel))) {
      matched.push(rel);
    }
  }
  if (matched.length === 0) return [];

  const tracked = await getTrackedFiles(baseRepo);
  const results: IncludeFileResult[] = [];

  for (const rel of matched) {
    const srcAbs = path.join(baseRepo, rel);
    const destAbs = path.join(destRoot, rel);

    // 安全闸门: dest 必须仍在 destRoot 下(防 .. 越权 — 即使 rel 是 listAllFiles
    // 返回的"听话"路径, 也加这道防御性检查, 免得未来改实现意外丢)
    const normalizedDest = path.resolve(destAbs);
    if (!normalizedDest.startsWith(path.resolve(destRoot) + path.sep)) {
      results.push({ relpath: rel, status: 'skipped-outside' });
      continue;
    }

    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(srcAbs);
    } catch {
      results.push({ relpath: rel, status: 'skipped-not-exist' });
      continue;
    }

    if (tracked.has(rel)) {
      results.push({ relpath: rel, status: 'skipped-tracked' });
      continue;
    }

    try {
      if (options.overwriteExisting === false) {
        try {
          fs.lstatSync(destAbs);
          results.push({ relpath: rel, status: 'skipped-existing' });
          continue;
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
        }
      }
      fs.mkdirSync(path.dirname(destAbs), { recursive: true });
      if (stat.isSymbolicLink()) {
        const link = fs.readlinkSync(srcAbs);
        // 已存在的目标先 unlink, fs.symlink 不会 overwrite
        try { fs.unlinkSync(destAbs); } catch { /* ignore */ }
        fs.symlinkSync(link, destAbs);
        results.push({ relpath: rel, status: 'copied-symlink' });
      } else if (stat.isFile()) {
        fs.copyFileSync(srcAbs, destAbs);
        results.push({ relpath: rel, status: 'copied' });
      } else {
        // 目录或特殊文件, 跳过
        results.push({ relpath: rel, status: 'skipped-not-exist' });
      }
    } catch (err) {
      results.push({
        relpath: rel,
        status: 'failed',
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return results;
}

export async function listChangedWorktreeIncludeFiles(
  baseRepo: string,
  destRoot: string,
): Promise<ChangedIncludeFile[]> {
  const includeFile = path.join(baseRepo, '.xdtworktreeinclude');
  let content: string;
  try {
    content = fs.readFileSync(includeFile, 'utf8');
  } catch {
    return [];
  }
  const patterns = parseWorktreeIncludePatterns(content);
  if (patterns.length === 0) return [];

  const regexes = patterns.map(globToRegex);
  const [trackedInBase, trackedInDest] = await Promise.all([
    getTrackedFiles(baseRepo),
    getTrackedFiles(destRoot),
  ]);
  const changed: ChangedIncludeFile[] = [];
  const destRootResolved = path.resolve(destRoot);
  const srcFiles = listAllFiles(baseRepo);

  for (const rel of srcFiles) {
    if (!regexes.some((re) => re.test(rel))) continue;
    if (trackedInBase.has(rel)) continue;

    const srcAbs = path.join(baseRepo, rel);
    const destAbs = path.join(destRoot, rel);
    const normalizedDest = path.resolve(destAbs);
    if (!normalizedDest.startsWith(destRootResolved + path.sep)) {
      changed.push({ relpath: rel, reason: 'outside' });
      continue;
    }

    let srcStat: fs.Stats;
    let destStat: fs.Stats;
    try {
      srcStat = fs.lstatSync(srcAbs);
    } catch {
      continue;
    }
    try {
      destStat = fs.lstatSync(destAbs);
    } catch {
      changed.push({ relpath: rel, reason: 'missing' });
      continue;
    }

    if (srcStat.isSymbolicLink()) {
      if (!destStat.isSymbolicLink()) {
        changed.push({ relpath: rel, reason: 'type-mismatch' });
        continue;
      }
      if (fs.readlinkSync(srcAbs) !== fs.readlinkSync(destAbs)) {
        changed.push({ relpath: rel, reason: 'symlink-differs' });
      }
      continue;
    }

    if (!srcStat.isFile()) continue;
    if (!destStat.isFile()) {
      changed.push({ relpath: rel, reason: 'type-mismatch' });
      continue;
    }
    if (srcStat.size !== destStat.size) {
      changed.push({ relpath: rel, reason: 'content-differs' });
      continue;
    }
    const srcContent = fs.readFileSync(srcAbs);
    const destContent = fs.readFileSync(destAbs);
    if (!srcContent.equals(destContent)) {
      changed.push({ relpath: rel, reason: 'content-differs' });
    }
  }

  // dest-only 扫描(review 反馈):只存在于 worktree 的 include 匹配文件——典型是
  // base 侧 .env 已删、或 worktree 内新建的本地配置。这类文件通常 gitignored
  // (`stash push -u` 不含 ignored 文件),上面的 base 侧循环也看不到,不报的话
  // 删除 worktree 会静默丢失且恢复时无源可拷。
  const srcSet = new Set(srcFiles);
  for (const rel of listAllFiles(destRoot)) {
    if (srcSet.has(rel)) continue;
    if (!regexes.some((re) => re.test(rel))) continue;
    // base 与 worktree 可能位于不同分支；dest-only 文件是否已提交必须按
    // worktree 自己的 index 判断，不能复用 base checkout 的 tracked 集合。
    if (trackedInDest.has(rel)) continue;

    let destStat: fs.Stats;
    try {
      destStat = fs.lstatSync(path.join(destRoot, rel));
    } catch {
      continue;
    }
    if (!destStat.isFile() && !destStat.isSymbolicLink()) continue;
    changed.push({ relpath: rel, reason: 'dest-only' });
  }

  return changed;
}

/**
 * 一站式: 读 .xdtworktreeinclude → 解析 → 拷贝。文件不存在则返回空。
 */
export async function applyWorktreeIncludeFile(
  baseRepo: string,
  destRoot: string,
  options: CopyWorktreeIncludeOptions = {},
): Promise<IncludeFileResult[]> {
  const includeFile = path.join(baseRepo, '.xdtworktreeinclude');
  let content: string;
  try {
    content = fs.readFileSync(includeFile, 'utf8');
  } catch {
    return [];
  }
  const patterns = parseWorktreeIncludePatterns(content);
  if (patterns.length === 0) return [];
  return copyWorktreeIncludeFiles(baseRepo, destRoot, patterns, options);
}

// 仅供测试用
export const _internal = { globToRegex, listAllFiles };
