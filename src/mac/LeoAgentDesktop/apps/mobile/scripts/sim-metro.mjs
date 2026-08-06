// 模拟器 / Metro 端口归属与 git env 的共享判断,供 sim-start.mjs / sim-rebuild.mjs 复用,
// 避免两边各自重复一套(以及"一个脚本加了校验、另一个忘了"的不一致)。macOS 专用(lsof/ps -E)。

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import net from 'node:net';
import { join, relative } from 'node:path';

// 连接探测:连得上 = 有进程在监听。比 listen(127.0.0.1) 可靠 —— Metro 监听 *:port(可能带
// SO_REUSEADDR),用 listen 探测会误判成空闲。
export function portInUse(port) {
  return new Promise((res) => {
    const sock = net.connect({ port, host: '127.0.0.1' });
    const done = (v) => { sock.destroy(); res(v); };
    sock.once('connect', () => done(true));
    sock.once('error', () => done(false));
    sock.setTimeout(500, () => done(false));
  });
}

// 监听该端口的第一个进程 pid(LISTEN)。
export function listenerPid(port) {
  try {
    return execFileSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'], { encoding: 'utf8' })
      .trim().split('\n')[0] || null;
  } catch {
    return null;
  }
}

// 进程工作目录(用 cwd 判 worktree,而非解析命令行 —— 命令行常是 `pnpm exec expo`、取不到
// worktree,且各 checkout 目录名不同)。macOS:lsof -a -p <pid> -d cwd -Fn。
export function cwdOfPid(pid) {
  try {
    const out = execFileSync('lsof', ['-a', '-p', pid, '-d', 'cwd', '-Fn'], { encoding: 'utf8' });
    const line = out.split('\n').find((l) => l.startsWith('n'));
    return line ? line.slice(1) : null;
  } catch {
    return null;
  }
}

/** Read the exact source token injected by sim:start from a running Metro. */
export function gitSourceOfPid(pid) {
  try {
    const out = execFileSync('ps', ['-ww', '-E', '-p', pid], { encoding: 'utf8' });
    const match = out.match(/EXPO_PUBLIC_XDT_GIT_SOURCE=(\S*)/);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

/**
 * Build a source identity that changes for commits and dirty worktree content.
 * This prevents a Metro started before an amend/reset/edit from posing as fresh.
 */
export function gitSourceIdentity(worktreeRoot, options = {}) {
  const run = options.execFile ?? execFileSync;
  const git = (args, extra = {}) => String(run('git', args, {
    cwd: worktreeRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 64 * 1024 * 1024,
    ...extra,
  })).trim();

  const branch = git(['branch', '--show-current']) || 'detached';
  const commit = git(['rev-parse', '--short=9', 'HEAD']) || 'unknown';
  const status = git(['status', '--porcelain=v1', '-z', '--untracked-files=all']);
  if (!status) return `${branch}@${commit}`;

  const hash = createHash('sha256');
  hash.update(status);
  hash.update(git(['diff', '--no-ext-diff', '--binary', 'HEAD', '--']));
  for (const entry of status.split('\0')) {
    if (!entry.startsWith('?? ')) continue;
    const relativePath = entry.slice(3);
    try {
      const absolutePath = join(worktreeRoot, relativePath);
      const stat = statSync(absolutePath);
      if (!stat.isFile()) continue;
      hash.update(relativePath);
      if (stat.size <= 10 * 1024 * 1024) hash.update(readFileSync(absolutePath));
      else hash.update(`${stat.size}:${stat.mtimeMs}`);
    } catch {
      hash.update(relativePath);
    }
  }
  return `${branch}@${commit}+${hash.digest('hex').slice(0, 10)}`;
}

// 真正的路径边界判断:避免 /workspace/XDMaker 与 /workspace/XDMaker-old 这种字符串前缀误判。
export function isInside(root, child) {
  const rel = relative(root, child);
  return rel === '' || !rel.startsWith('..');
}
