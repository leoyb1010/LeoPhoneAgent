/**
 * Memory 抽象 — agent "自动记忆" 功能的统一控制面。
 *
 * 范围: 仅指 agent 自己沉淀的"自动记忆", 不含用户手写的 CLAUDE.md / AGENTS.md
 * (那些走 settingSources / project_doc_max_bytes, 不在本抽象内)。
 *
 * 落地映射:
 *  - Claude → SDK Settings.autoMemoryEnabled (+ 联动 autoDreamEnabled),
 *             存储 ~/.claude/projects/<sanitized-cwd>/memory/
 *  - Codex  → app-server experimentalFeature/enablement/set { memories },
 *             存储 <CODEX_HOME>/memories/ + <CODEX_HOME>/state_*.sqlite stage
 *
 * 详见 packages/maker-core/src/agents/{claude-code,codex}/index.ts 子类实现。
 */

/**
 * 当前 memory 通道状态 + 来源标注 + (可选) 用量元数据。
 *
 * source 字段语义:
 *  - 'agent-default'   : runtimeConfig.memoryEnabled 没传 + 没人调过 setMemory,
 *                        当前值是 SDK / app-server 自己的默认 (Claude=true, Codex=false)。
 *                        UI 可据此标 "未设置 (默认开/关)"。
 *  - 'host-runtime'    : 由 host (xdt-maker) 通过 runtimeConfig.memoryEnabled 注入,
 *                        或调过 setMemory 显式覆盖。
 *  - 'user-config'     : 来自用户配置文件层 (e.g. codex config.toml [features].memories
 *                        在用户没改过 host override 时也算这里)。
 */
export interface MemoryStatus {
  enabled: boolean;
  source: 'agent-default' | 'host-runtime' | 'user-config';
  /**
   * 用量元数据 — 可选, 子类按需提供 (要 fs stat, 不强求实现)。
   * UI 用于 "已记录 N 条 / 占用 X KB" 这类提示。
   */
  stats?: MemoryStats;
}

export interface MemoryStats {
  /** 记忆条目数 (CC: memory dir 下 .md 文件数; Codex: 先不实现, 留 undefined) */
  entryCount?: number;
  /** 占用字节数 */
  sizeBytes?: number;
  /** 数据存放绝对路径, UI 给 "在文件管理器中显示" 按钮用 */
  storagePath?: string;
}

export interface MemorySetResult {
  /**
   * 设置完是否当下生效:
   *  - 'immediate'    : 已经在所有 live 上下文生效 (Codex 通过 app-server 热重载)
   *  - 'next-session' : 只对未来 startSession 生效, 当前 live session 仍按旧值跑
   *                     (CC: applyFlagSettings 是 per-Query, BaseAgent 不追踪 active sessions)
   *
   * UI 看到 'next-session' 时应提示 "新会话生效"。
   */
  effective: 'immediate' | 'next-session';
}

export interface MemoryResetResult {
  /** 删除的记忆条目数 (CC: 累计所有项目下 memory/ 子目录的 .md 文件数; Codex: 先不实现) */
  removedEntries?: number;
  /** 删除的总字节数 */
  removedBytes?: number;
}
