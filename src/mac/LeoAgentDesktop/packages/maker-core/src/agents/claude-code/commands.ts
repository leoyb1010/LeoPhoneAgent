/**
 * ClaudeCodeAgent built-in commands — hard-coded whitelist.
 *
 * 这是 ChatInput `/` palette 中归类为 'agent-builtin' 的命令清单。
 * 执行方式: 由 desktop 把 `/<name> [args]` 当 prompt 前缀直接发给 agent,
 * Claude Code SDK 自己识别处理(SDK 内部已实现 /compact /memory /resume 等)。
 *
 * 是"白名单"不是"全集" —— 我们只暴露想给用户用的子集,即便 SDK 支持更多
 * 内置命令也不一定在这里出现。新增/移除一条都是显式编辑此文件,不从 SDK
 * 自动派生。
 *
 * 与 listAgentSkills 的区别:
 *   - 这里: SDK 自带能力,半静态,无 IO,首屏直接出
 *   - listAgentSkills: 用户/项目目录扫 .md, 有 IO, 走缓存
 */

import type { AgentBuiltinCommand } from '../../types/palette.js';

export const CLAUDE_CODE_AGENT_COMMANDS: AgentBuiltinCommand[] = [
  {
    kind: 'agent-builtin',
    name: 'compact',
    description:
      'Clear conversation history but keep a summary in context. Optional: /compact [instructions].',
  },
  {
    kind: 'agent-builtin',
    name: 'context',
    description:
      'Visualize current context window usage as a colored grid — see what is taking up tokens (system prompt, tools, messages, free space).',
  },
];
