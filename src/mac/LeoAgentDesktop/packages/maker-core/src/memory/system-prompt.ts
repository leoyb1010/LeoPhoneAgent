/**
 * Maker Memory 写入规范段 — 注入到 agent system prompt 末尾, 教 LLM 怎么用
 * cindy_memory MCP server (writing rules + override + tool usage)。
 *
 * 真正内容在同目录 system-prompt.md, vite 编译时通过 ?raw 内联为字符串。
 *
 * 使用方:
 *  - claude-code/index.ts startSession 拼 systemPrompt.append 时, makerMemoryEnabled
 *    为 true 才注入 (跟 maker engine append 同段, 见 system-prompt-append.ts)
 *  - codex/index.ts 同上, 拼 developerInstructions
 *
 * 跟 MEMORY.md 内容是两段:
 *  - MAKER_MEMORY_RULES (本段): 静态文案, 教 LLM 用法 + 触发条件
 *  - MEMORY.md content: 当前 workdir 索引, 由 storage.getIndex() 异步拉, 每次新
 *    session 启动时快照拼入 (跟 user prompt 同语义)
 */

import promptText from './system-prompt.md?raw';

export const MAKER_MEMORY_RULES = promptText.trim();
