/**
 * 系统已装 CLI 解析(LeoAgent 分叉新增,2026-08-06)。
 *
 * 上游的模型是「厂商二进制由自家 CDN 分发、按 SHA-256 校验后装进 userData」。
 * 本产品没有那个 CDN,也不该有:它驱动的本来就是**用户自己机器上已经装好、
 * 已经登录好的** claude / codex —— 用户在终端里跑的是哪一个,桌面端就该跑哪一个,
 * 否则同一台机器上会出现两份不同版本、各自独立登录态的同名 CLI。
 *
 * 因此这里在所有平台(含 packaged)提供一条系统 CLI 解析链,排在 CDN 下载之前。
 * 上游 Linux 那条 runtime fallback 语义相同,只是被限死在 Linux —— 这里不改它,
 * 只在它前面加一条平台无关的。
 *
 * 安全边界:只接受**绝对路径的可执行文件**,且必须能跑通 `--version`。PATH 由
 * main 入口的 fix-path 从登录 shell 取得(GUI 启动的 app 拿不到用户 shell 的
 * PATH,这是 macOS 上的老问题)。
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export type SystemCliKind = 'claude-code' | 'codex' | 'pi';

const COMMAND_NAME: Record<SystemCliKind, string> = {
  'claude-code': 'claude',
  codex: 'codex',
  pi: 'pi',
};

const VERIFY_TIMEOUT_MS = 10_000;
const LOOKUP_TIMEOUT_MS = 5_000;

/** 常见的用户级安装位置。PATH 没带全时(GUI 启动)靠这个兜底。 */
function candidateDirs(): string[] {
  const home = process.env.HOME ?? '';
  const dirs = [
    path.join(home, '.local', 'bin'),
    path.join(home, '.local', 'npm-global', 'bin'),
    path.join(home, 'bin'),
    '/opt/homebrew/bin',
    '/usr/local/bin',
    '/usr/bin',
  ];
  // nvm 的当前版本目录(node 装的 CLI 常在这里)
  const nvmRoot = path.join(home, '.nvm', 'versions', 'node');
  try {
    for (const entry of fs.readdirSync(nvmRoot)) {
      dirs.push(path.join(nvmRoot, entry, 'bin'));
    }
  } catch {
    /* 没装 nvm */
  }
  // grok 之类自带目录
  dirs.push(path.join(home, '.grok', 'bin'), path.join(home, '.codex', 'bin'));
  return dirs;
}

function isExecutableFile(p: string): boolean {
  try {
    const st = fs.statSync(p);
    if (!st.isFile()) return false;
    fs.accessSync(p, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** PATH + 候选目录里找命令,返回绝对路径。不执行任何 shell。 */
export function findSystemCliPath(kind: SystemCliKind): string | null {
  const cmd = COMMAND_NAME[kind];
  const exe = process.platform === 'win32' ? `${cmd}.exe` : cmd;
  const fromPath = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
  for (const dir of [...fromPath, ...candidateDirs()]) {
    if (!dir) continue;
    const candidate = path.isAbsolute(dir) ? path.join(dir, exe) : null;
    if (candidate && isExecutableFile(candidate)) return candidate;
  }
  return null;
}

/** 跑一次 `--version` 确认它真的能启动(存在且可执行 ≠ 能用)。 */
export function verifySystemCli(binaryPath: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      binaryPath,
      ['--version'],
      { timeout: VERIFY_TIMEOUT_MS, windowsHide: true },
      (err, stdout) => {
        if (err) {
          resolve(null);
          return;
        }
        const line = String(stdout || '').trim().split('\n')[0] ?? '';
        resolve(line || 'unknown');
      },
    );
  });
}

export interface SystemCliResolution {
  path: string;
  version: string;
}

/** 解析并验证系统 CLI;任一步失败返回 null,由调用方走原有下载链。 */
export async function resolveSystemCli(kind: SystemCliKind): Promise<SystemCliResolution | null> {
  const found = findSystemCliPath(kind);
  if (!found) return null;
  const version = await Promise.race([
    verifySystemCli(found),
    new Promise<null>((r) => setTimeout(() => r(null), LOOKUP_TIMEOUT_MS + VERIFY_TIMEOUT_MS)),
  ]);
  if (!version) return null;
  return { path: found, version };
}
