// [leo] 本机 LeoBot 凭据文件：Read 一律拒绝。读进上下文的内容会发给模型服务商、存进会话库；
// leo-brain 工具缺失时有 agent 自己去读过第二大脑的 key。这里只是兜底，Bash 等其他路径不在此列。

import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join, normalize, sep } from "node:path";

import { CoreErrorType, createCoreError } from "@zcode/contracts";

function isLeoSecretPath(path: string, home: string): boolean {
  // macOS 默认大小写不敏感：~/.LeoAgent/KEY 读到的是同一个文件。
  const target = normalize(path).toLowerCase();
  const brainDir = join(home, ".config", "leo-brain").toLowerCase();
  return (
    target.startsWith(brainDir + sep) ||
    target === join(home, ".leoagent", "key").toLowerCase() ||
    target === join(home, ".leoagent", "treasury.key").toLowerCase()
  );
}

function realOrSelf(path: string): string {
  try {
    return realpathSync.native(path);
  } catch {
    return path; // 不存在：按原路径判断。
  }
}

/** 路径本身或它解析出的真实文件是凭据就抛错（挡住符号链接绕路）。 */
export function assertLeoReadAllowed(filePath: string, home: string = homedir()): void {
  const paths = [filePath, realOrSelf(filePath)];
  const homes = [home, realOrSelf(home)];
  if (!paths.some((path) => homes.some((dir) => isLeoSecretPath(path, dir)))) return;
  throw createCoreError(
    CoreErrorType.ToolExecutionFailed,
    "Reading this file is blocked: it holds a LeoBot credential (second-brain or treasury key). Do not try to read it another way. Use the mcp__leo-brain__* / mcp__leo-treasury__* tools instead; if they are missing or failing, tell the user.",
    { context: { operation: "read" }, recoverable: false },
  );
}
