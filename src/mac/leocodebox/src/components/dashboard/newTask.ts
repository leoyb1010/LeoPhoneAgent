import type { LLMProvider } from '../../types/app';

/** 主控台「新任务」下拉里的一个 Agent。 */
export type ConsoleAgentOption = {
  provider: string;
  label: string;
  /** 「v2.1.4 · 已连接」这类副标题,和设置页读同一份事实。 */
  status?: string;
  /** 未安装的 Agent 仍然列出来(告诉用户它存在),但不能选。 */
  disabled?: boolean;
};

/** 本机 + 在线远程 Mac。`name` 为 null 表示本机。 */
export type ConsoleMachineOption = {
  name: string | null;
  label: string;
  desc?: string;
};

export type ConsoleProjectOption = {
  projectId: string;
  displayName: string;
  path?: string;
};

/**
 * 主控台发起一个新任务时,交给外壳的完整意图。
 *
 * 关键在 `provider`:它是**用户在主控台明确选的那个 Agent**,而不是"当前会话
 * 恰好是谁"。1.68 删掉首页之后所有 Agent 切换都发生在某个已绑定 Agent 的会话
 * 内部,代码只能猜用户想改这个会话还是想开新的 —— 猜错就是「选了 Codex 发出去
 * 还是 Claude」。把选择显式写进创建请求,就没有可猜的余地。
 */
export type NewTaskLaunch = {
  provider: LLMProvider;
  /** 任务落在哪个项目目录;主控台不允许在没有目录的情况下发起。 */
  projectId: string;
  /** null = 本机;非空 = 经中继下发到那台远程 Mac。 */
  machine: string | null;
  prompt: string;
};
