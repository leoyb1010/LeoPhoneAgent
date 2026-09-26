// ============================================================
// [leo] 精简档（lean profile）：最小系统提示词 + 核心工具
// ============================================================
// 默认关闭；config.json 的 "leo": { "leanProfile": true }（或 ZCODE_LEO_AGENT）打开。
// 打开后只作用于主会话（不影响子代理 / 工作流子会话，它们各有自己的提示词与工具面）：
//   - 工具：只注册 Bash / Read / Edit / Write / Glob / Grep，MCP 工具也不注册；
//   - 提示词：走上游 customSystemPrompt 通道（跳过 desktop / 行为规范 / 会话指引 / 记忆 /
//     输出风格 / 上下文管理等动态段），正文是下面这段简短指引 + 环境信息；AGENTS.md 指令、
//     项目记忆索引和日期照常作为 meta user 注入。
// 用户自己配置了 systemPrompt 时以用户的为准。

import type { Model } from "@zcode/contracts";
import { buildEnvInfoSection } from "../../context/sections/env-info.js";
import type { EnvInfo } from "../../context/types.js";
import type { AgentRuntimeConfig } from "../types.js";

export const LEO_LEAN_CORE_TOOLS: readonly string[] = ["Bash", "Read", "Edit", "Write", "Glob", "Grep"];

const CHILD_TASK_TYPES = new Set(["workflow_child", "subagent_child", "nested_workflow_child"]);

const LEAN_PROMPT = [
  "You work in the user's project through a few tools: Read (view files), Edit (change files; several edits per call), Write (create or fully rewrite files), Bash (run commands, tests, git, search), Glob/Grep (find files and text).",
  "",
  "- Read the relevant code before changing it; make the smallest change that solves the task and match the existing style.",
  "- Prefer Edit for existing files; use Write only for new files or complete rewrites.",
  "- Verify your work: run the project's tests, type checks or the program itself when you can.",
  "- Keep going until the task is done; ask the user only when the goal is ambiguous or an action would be destructive.",
  "- Answer concisely: say what you changed and anything you could not verify.",
].join("\n");

export function isLeoLeanProfileActive(config: AgentRuntimeConfig): boolean {
  return (
    config.leoAgent?.leanProfile === true &&
    config.workflowActor === undefined &&
    config.subagentContext === undefined &&
    !CHILD_TASK_TYPES.has(config.taskType ?? "interactive")
  );
}

/** 精简档下的工具白名单（与已有白名单取交集）；未开启时返回 undefined，不改变上游结果。 */
export function applyLeoLeanToolAllowlist(
  config: AgentRuntimeConfig,
  allowlist: readonly string[] | undefined,
): readonly string[] | undefined {
  if (!isLeoLeanProfileActive(config)) return allowlist;
  if (!allowlist) return LEO_LEAN_CORE_TOOLS;
  const core = new Set(LEO_LEAN_CORE_TOOLS);
  return allowlist.filter((toolName) => core.has(toolName));
}

/** 精简档的系统提示词正文；未开启或用户已有 systemPrompt 时返回 undefined。 */
export function buildLeoLeanSystemPrompt(
  config: AgentRuntimeConfig,
  envInfo: EnvInfo,
  model: Model | undefined,
): string | undefined {
  if (config.systemPrompt?.trim() || !isLeoLeanProfileActive(config)) return undefined;
  return `${LEAN_PROMPT}\n\n${buildEnvInfoSection(envInfo, model).content}`;
}
