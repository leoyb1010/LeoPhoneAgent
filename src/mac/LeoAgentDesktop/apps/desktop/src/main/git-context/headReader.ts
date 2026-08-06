/**
 * git-context/headReader — 直读 .git/HEAD 解析当前分支的纯函数层。
 *
 * 为什么不走 gitExec(spawn git):分支名只需要读一个几十字节的文本文件,
 * fs 直读比起子进程快几个数量级,且会被 HEAD watcher 在每次切分支时调用,
 * 必须是零开销路径。git rev-parse 留给确实需要 git 语义的场景(worktree 模块)。
 *
 * 覆盖三种形态:
 *   1. 普通 checkout:`<repo>/.git` 是目录,HEAD 在 `.git/HEAD`
 *   2. linked worktree:`<repo>/.git` 是文件,内容 `gitdir: <path>`(绝对或相对),
 *      HEAD 在 `<path>/HEAD`(通常是主仓 `.git/worktrees/<name>/HEAD`)
 *   3. detached HEAD:HEAD 内容是裸 40 位 hex 而非 `ref: refs/heads/...`
 *
 * 所有函数不抛错——任何 IO / 解析失败都返回 null(非 git 目录是常态而非异常)。
 */

import * as fs from 'node:fs/promises';
import path from 'node:path';

/** 当前 HEAD 指向的解析结果。 */
export interface GitHeadInfo {
  /** branch = 在分支上;detached = 游离 HEAD。 */
  kind: 'branch' | 'detached';
  /** kind=branch 时的分支名(如 'feat/xxx');detached 时为 null。 */
  branch: string | null;
  /** kind=detached 时的短 sha(前 8 位);branch 时为 null。 */
  shortSha: string | null;
}

/** HEAD 文件定位结果——headPath 同时是 watcher 的监听目标。 */
export interface GitHeadLocation {
  /** HEAD 文件绝对路径。 */
  headPath: string;
  /** HEAD 所在目录(gitdir),watcher 订阅这个目录。 */
  gitDir: string;
}

/** 向上最多走多少层目录找 .git(防御环形/超深路径)。 */
const MAX_WALK_UP = 50;

/**
 * 从 workdir 向上查找 .git,解析出 HEAD 文件的真实位置。
 * 非 git 目录 / 解析失败返回 null。
 */
export async function resolveHeadLocation(workdir: string): Promise<GitHeadLocation | null> {
  let dir = path.resolve(workdir);
  for (let i = 0; i < MAX_WALK_UP; i++) {
    const dotGit = path.join(dir, '.git');
    const stat = await fs.stat(dotGit).catch(() => null);
    if (stat) {
      if (stat.isDirectory()) {
        return { headPath: path.join(dotGit, 'HEAD'), gitDir: dotGit };
      }
      if (stat.isFile()) {
        // linked worktree:.git 文件内容形如 `gitdir: /abs/or/relative/path`
        const content = await fs.readFile(dotGit, 'utf8').catch(() => null);
        const m = content?.match(/^gitdir:\s*(.+)\s*$/m);
        if (!m) return null;
        const gitDir = path.resolve(dir, m[1].trim());
        return { headPath: path.join(gitDir, 'HEAD'), gitDir };
      }
      return null;
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null; // 已到文件系统根
    dir = parent;
  }
  return null;
}

/**
 * 解析 HEAD 文件内容。两种合法形态:
 *   `ref: refs/heads/<branch>` → 在分支上
 *   `<40-hex sha>`             → detached HEAD
 * 其它内容(refs/tags 等异常态)返回 null。
 */
export function parseHeadContent(content: string): GitHeadInfo | null {
  const line = content.split('\n', 1)[0]?.trim() ?? '';
  const refMatch = line.match(/^ref:\s*refs\/heads\/(.+)$/);
  if (refMatch) {
    return { kind: 'branch', branch: refMatch[1], shortSha: null };
  }
  if (/^[0-9a-f]{40}$/i.test(line)) {
    return { kind: 'detached', branch: null, shortSha: line.slice(0, 8) };
  }
  return null;
}

/**
 * 一步到位:workdir → 当前 HEAD 信息。非 git 目录返回 null。
 */
export async function readGitHead(workdir: string): Promise<GitHeadInfo | null> {
  const loc = await resolveHeadLocation(workdir);
  if (!loc) return null;
  const content = await fs.readFile(loc.headPath, 'utf8').catch(() => null);
  if (content === null) return null;
  return parseHeadContent(content);
}
