/**
 * CodexAgent built-in commands — hard-coded whitelist.
 *
 * 见 claude-code/commands.ts 的说明: 这是 'agent-builtin' 类目的展示白名单,
 * 不是 codex app-server 的全部内置能力。新增/移除都是显式编辑。
 *
 * 当前为空 —— Codex 走 app-server 协议, 内置 slash 大多由 server 侧
 * skills/list 暴露(归 agent-skill 类目)。如果以后想把某个 server 端
 * 命令固定置顶到 builtin 类目, 在这里加一条即可。
 */

import type { AgentBuiltinCommand } from '../../types/palette.js';

export const CODEX_AGENT_COMMANDS: AgentBuiltinCommand[] = [];
