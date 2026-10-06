import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import type { ZCodePermissionOption, ZCodePermissionRequest } from "@zcode/shared";

/**
 * [leo] 聊天机器人(Telegram、飞书、微信、Webhook)遥控的安全规则,与手机桥接的旧通道同一套。
 *
 * 上游把机器人建的任务一律锁成 yolo,审批根本不出现 —— 等于把这台 Mac 的命令行交给
 * 任何拿到机器人会话的人。LeoPhoneAgent 改成 build:改文件照常,危险动作要批;
 * 而在聊天里只能批只读工具和工作区内的改文件,命令、联网、MCP、工作流只能拒绝,
 * 要做就回 iPhone App 或 Mac 上批。也不给「本项目总是允许」—— 聊天里点一下不该写出持久规则。
 */
export const LEO_BOT_FORCED_MODE = "build";

/** 只读、不联网的工具。WebFetch / WebSearch 声明了只读,但会联网,不在内。 */
const READ_ONLY_TOOLS = new Set(["Read", "Glob", "Grep", "LS", "TodoRead", "TodoWrite"]);
const EDIT_TOOLS = new Set(["Edit", "MultiEdit", "Write", "NotebookEdit"]);

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function isInside(root: string, target: string): boolean {
  if (!root || !target) return false;
  const resolvedRoot = realish(path.resolve(root));
  const relative = path.relative(resolvedRoot, realish(path.resolve(root, target)));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/** 解析符号链接:目标可能还不存在(新建文件),就解析最近一级存在的祖先再拼回去。 */
function realish(absolute: string): string {
  let current = absolute;
  const rest: string[] = [];
  for (;;) {
    try {
      return path.join(realpathSync(current), ...rest);
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return absolute;
      rest.unshift(path.basename(current));
      current = parent;
    }
  }
}

/**
 * 工作区里改了就等于能执行命令的位置:Git 钩子与配置、各家 agent / MCP 配置、direnv。
 * 聊天里批不了,要改回 iPhone App 或 Mac 上批。
 */
const EXECUTABLE_CONFIG_DIRS = new Set([".git", ".zcode", ".agents", ".claude", ".codex", ".grok", ".cursor", ".vscode", ".husky"]);
const EXECUTABLE_CONFIG_FILES = new Set([".envrc", ".mcp.json", ".npmrc", ".gitmodules"]);

function touchesExecutableConfig(root: string, target: string): boolean {
  const relative = path.relative(realish(path.resolve(root)), realish(path.resolve(root, target)));
  const segments = relative.split(path.sep);
  return (
    segments.some((segment) => EXECUTABLE_CONFIG_DIRS.has(segment)) ||
    EXECUTABLE_CONFIG_FILES.has(segments.at(-1) ?? "")
  );
}

function pathArgs(input: unknown, keys: readonly string[]): string[] {
  const obj = record(input);
  return keys
    .map((key) => obj[key])
    .filter((value): value is string => typeof value === "string" && value.trim() !== "")
    .map((value) => value.trim())
    // 工具会展开 ~:按用户目录算,别当成工作区里一个叫「~」的子目录。
    .map((value) => (value === "~" || value.startsWith("~/") ? path.join(homedir(), value.slice(1)) : value));
}

export function botMayAllow(toolName: string, input: unknown, workspacePath: string): boolean {
  if (READ_ONLY_TOOLS.has(toolName)) {
    // 只读也只限工作区:否则聊天里批一下 Read ~/.ssh/id_ed25519,内容就回到聊天里了。
    // Glob 的 pattern 可以是绝对路径,一并检查;没给路径的默认就在工作区。
    const targets = pathArgs(input, ["file_path", "path", "notebook_path"]);
    const pattern = pathArgs(input, ["pattern"]).find((value) => path.isAbsolute(value));
    if (pattern) targets.push(pattern.split(/[*?[{]/, 1)[0]!);
    return targets.every((target) => isInside(workspacePath, target));
  }
  if (!EDIT_TOOLS.has(toolName)) return false;
  // 每个路径参数都要过:只查第一个的话,放一个工作区内的 file_path 当幌子就能改外面的 notebook_path。
  const targets = pathArgs(input, ["file_path", "path", "notebook_path"]);
  return (
    targets.length > 0 &&
    targets.every((target) => isInside(workspacePath, target) && !touchesExecutableConfig(workspacePath, target))
  );
}

/**
 * 机器人能给出的选项:允许的只留「允许一次」和「拒绝」,不允许的只剩「拒绝」。
 * 按钮与 /approve 命令都只认这里留下的选项,所以过滤一次就覆盖三处应答入口。
 */
export function filterBotPermissionOptions(event: Pick<ZCodePermissionRequest, "options" | "raw" | "kind">, workspacePath: string): ZCodePermissionOption[] {
  const raw = record(event.raw);
  const toolName = typeof raw["toolName"] === "string" ? raw["toolName"] : event.kind;
  const allow = botMayAllow(toolName, raw["input"], workspacePath);
  const isReject = (option: ZCodePermissionOption) => option.kind === "deny" || option.kind.startsWith("reject");
  return event.options.filter((option) => isReject(option) || (allow && option.kind === "allow_once"));
}
