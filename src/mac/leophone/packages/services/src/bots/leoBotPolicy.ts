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
  const relative = path.relative(path.resolve(root), path.resolve(root, target));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export function botMayAllow(toolName: string, input: unknown, workspacePath: string): boolean {
  if (READ_ONLY_TOOLS.has(toolName)) return true;
  if (!EDIT_TOOLS.has(toolName)) return false;
  const obj = record(input);
  const target = [obj["file_path"], obj["path"], obj["notebook_path"]].find((value) => typeof value === "string" && value.trim());
  return typeof target === "string" && isInside(workspacePath, target.trim());
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
