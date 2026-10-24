import { join } from "node:path";
import {
  BUILTIN_WORKFLOW_COMMAND_NAME,
  expandBuiltinWorkflowCommandPrompt,
} from "./builtin-workflow-command.js";

const BUILTIN_PROMPT_COMMAND_PATTERN = /^\/([^\s]+)(?:\s+([\s\S]*))?$/;
const INIT_COMMAND_NAME = "init";
const REVIEW_COMMAND_NAME = "review"; // [leo]
const IMAGE_COMMAND_NAME = "image"; // [leo]

export interface ResolveZCodeBuiltinPromptCommandOptions {
  /**
   * 动态工作流灰度门（docs/dynamic-workflow/launch.md「Gray release」）。**只有显式 false 才挡下**
   * `/workflow`：TUI / headless 从不设置该字段，那里的功能始终开启。挡下时返回 undefined，
   * 与「命令不存在」同形——`workflow` 是保留名，后续的自定义命令解析同样拒绝展开，于是原文作为
   * 普通 prompt 交给模型，与目录侧剔除它的结论一致（DWG-03）。
   */
  dynamicWorkflowEnabled?: boolean;
  workingDirectory?: string;
}

export interface ResolvedZCodeBuiltinPromptCommand {
  /** 命中的内置命令名（`init` / `workflow`），调用方据此挂命令特有的副作用（如 onDemand 激活）。 */
  name: string;
  prompt: string;
}

export function resolveZCodeBuiltinPromptCommand(
  input: string,
  options: ResolveZCodeBuiltinPromptCommandOptions = {},
): string | undefined {
  return resolveZCodeBuiltinPromptCommandInvocation(input, options)?.prompt;
}

export function resolveZCodeBuiltinPromptCommandInvocation(
  input: string,
  options: ResolveZCodeBuiltinPromptCommandOptions = {},
): ResolvedZCodeBuiltinPromptCommand | undefined {
  const invocation = parseBuiltinPromptCommandInvocation(input);
  if (!invocation) {
    return undefined;
  }

  if (invocation.name === INIT_COMMAND_NAME) {
    const workingDirectory = options.workingDirectory ?? process.cwd();
    return {
      name: INIT_COMMAND_NAME,
      prompt: buildInitAgentsPrompt({
        args: invocation.args,
        targetPath: join(workingDirectory, "AGENTS.md"),
        workingDirectory,
      }),
    };
  }

  if (invocation.name === REVIEW_COMMAND_NAME) {
    return { name: REVIEW_COMMAND_NAME, prompt: buildReviewPrompt(invocation.args) };
  }

  if (invocation.name === IMAGE_COMMAND_NAME) {
    return { name: IMAGE_COMMAND_NAME, prompt: buildImagePrompt(invocation.args) };
  }

  if (invocation.name === BUILTIN_WORKFLOW_COMMAND_NAME) {
    if (options.dynamicWorkflowEnabled === false) {
      return undefined;
    }
    return {
      name: BUILTIN_WORKFLOW_COMMAND_NAME,
      prompt: expandBuiltinWorkflowCommandPrompt(invocation.args),
    };
  }

  return undefined;
}

function parseBuiltinPromptCommandInvocation(input: string): { args: string; name: string } | null {
  const match = BUILTIN_PROMPT_COMMAND_PATTERN.exec(input.trim());
  if (!match?.[1]) {
    return null;
  }
  return {
    args: match[2]?.trim() ?? "",
    name: match[1].toLowerCase(),
  };
}

function buildInitAgentsPrompt(params: {
  args: string;
  targetPath: string;
  workingDirectory: string;
}): string {
  const additionalInstructions = params.args
    ? [
        "",
        "Additional user instructions supplied with /init:",
        "```text",
        params.args,
        "```",
      ].join("\n")
    : "";

  return [
    "You are running LeoBot's built-in /init command.",
    "",
    "Your task is to create or update a concise workspace instruction file for future LeoBot agents.",
    "",
    "Target:",
    `- Workspace directory: ${params.workingDirectory}`,
    `- Instruction file: ${params.targetPath}`,
    `- Existing hidden instruction candidates: ${join(params.workingDirectory, ".zcode", "AGENTS.md")} and ${join(params.workingDirectory, ".agents", "AGENTS.md")}`,
    "- File name must be exactly AGENTS.md.",
    "- This command targets the current workspace only. Do not write ~/.leophoneagent/AGENTS.md.",
    additionalInstructions,
    "",
    "Process:",
    "1. First check whether .zcode/AGENTS.md or .agents/AGENTS.md exists in the workspace. If either exists, tell the user they already have an instructions file, mention the path found, and stop without creating a new AGENTS.md.",
    "2. Inspect the repository before writing. Prefer Read, Glob, Grep, and safe Bash commands such as ls, find, git status, and package-manager script inspection.",
    "3. If AGENTS.md already exists, read it first and update it with Edit instead of replacing it wholesale.",
    "4. If AGENTS.md does not exist, create it at the workspace root.",
    "5. Keep the file practical and short enough for future agents to read quickly.",
    "6. Include only project-specific facts future LeoBot agents would otherwise miss.",
    "7. Ask the user only if a repository-specific decision cannot be inferred and would materially change the file.",
    "",
    "Recommended AGENTS.md content:",
    "- Repository purpose and major directories.",
    "- Build, typecheck, lint, and focused test commands discovered from the repo.",
    "- Architecture boundaries and layer rules that matter for edits.",
    "- Coding conventions, import/path rules, logging rules, UI/design rules, and platform compatibility constraints if present.",
    "- Known gotchas for desktop app, web, remote, stdio, protocols, or agent runtime if this repo has them.",
    "- Any documentation files that agents should read before changing sensitive areas.",
    "",
    "After creating or editing AGENTS.md, summarize the main sections you wrote and mention the file path.",
  ].join("\n");
}

/** [leo] `/review [base-ref]`：只读审查当前改动，发现逐条用桌面端的 ::code-comment 卡片输出。 */
function buildReviewPrompt(baseRef: string): string {
  const diffCommand = baseRef
    ? `git diff ${baseRef}...HEAD（与 ${baseRef} 的分叉点相比，本分支提交的改动）`
    : "git diff HEAD（工作区 + 暂存区相对 HEAD 的全部未提交改动）；另用 git status 看有没有未跟踪的新文件，需要时直接读它们";
  return [
    "你在执行 LeoBot 内置的 /review 命令：对当前代码改动做一次代码审查。",
    "",
    "范围：",
    `- 用 ${diffCommand} 取得改动。`,
    "- 改动为空就直接告诉用户没有可审查的改动，然后结束。",
    "- 只读：不要修改、创建或删除任何文件，不要提交、切分支、stash 或 reset；只用 git diff/log/show/status 和读文件、搜索类工具。",
    "",
    "关注点（按重要性）：",
    "1. 正确性 bug：逻辑错误、边界条件、空值、并发/竞态、错误处理缺失、资源泄漏。",
    "2. 安全问题：注入、越权、敏感信息泄露、不安全的输入处理。",
    "3. 回归：改动破坏了现有调用方、接口契约或既有行为（必要时读调用方代码确认）。",
    "4. 缺失的测试：关键新逻辑或修复没有对应测试。",
    "- 不要挑纯风格、命名之类的小毛病；只报有把握、值得改的问题，读上下文核实后再下结论。",
    "",
    "输出：",
    '- 每个发现输出一条 ::code-comment{title="[P1] 简短标题" body="一段话说明问题、触发条件和建议改法" file="/绝对路径" start=行号 end=行号 priority=1}。',
    "- priority 0-3，0 最严重（P0 阻断上线 / P1 应该修 / P2 建议修 / P3 次要），title 前缀与 priority 一致；按严重度从高到低排列。",
    "- file 用绝对路径，行号对应改动后的文件，范围尽量收窄。",
    "- 最后用几句话总结：整体结论（能否合入）、发现数量、最需要先处理的问题；没有发现就明确说没发现问题。",
  ].join("\n");
}

/** [leo] `/image <描述>`：调用 leo-media 的 generate_image 工具生成图片并原样贴出返回的 Markdown。 */
function buildImagePrompt(description: string): string {
  if (!description) {
    return "用户输入了 /image 但没有给出描述。请简短地问用户想画什么（主体、风格、尺寸等），先不要调用任何工具。";
  }
  return [
    "你在执行 LeoBot 内置的 /image 命令：根据用户的描述生成图片。",
    "",
    "用户的描述：",
    "```text",
    description,
    "```",
    "",
    "步骤：",
    "1. 调用 generate_image 工具（leo-media MCP 服务）。prompt 以用户描述为准，可适度补充主体细节、风格、构图、光线以提高出图质量，但不要改变用户本意。",
    '2. 用户提到了尺寸或张数时，分别传 size（如 "1024x1024"）和 n（1-4）；没提就不传。',
    "3. 把工具返回的 Markdown（![...](...)）原样贴进回答，不要改路径或改写成别的格式，再补一句简短说明生成了什么。",
    "4. 如果没有 generate_image 工具或调用出错，直接如实告诉用户原因，并建议在 设置 → 模型供应商 里添加图像模型（例如 gemini-3.1-flash-image 或 grok-imagine-image）。",
  ].join("\n");
}
