/** 会话侧 useChatProviderState 监听的 provider 意图事件。 */
export const AGENT_INTENT_EVENT = 'leocodebox-preferences:changed';

/** 在新会话建立前对齐工作台选择与真实 CLI provider。 */
export function announceAgentIntent(provider: string, effort?: string): void {
  if (typeof window === 'undefined' || !provider) return;
  const detail: { defaultProvider: string; effort?: string } = { defaultProvider: provider };
  if (effort) detail.effort = effort;
  window.dispatchEvent(new CustomEvent(AGENT_INTENT_EVENT, { detail }));
}

const SELECTED_PROVIDER_KEY = 'selected-provider';

/**
 * 新任务页没有挂载 ChatInterface，因此选择既持久化，也向
 * 已挂载的会话发送事件。这保证用户选的 Agent 就是真正运行的 Agent。
 */
export function commitAgentForNewSession(provider: string, effort?: string): void {
  if (!provider) return;
  try {
    localStorage.setItem(SELECTED_PROVIDER_KEY, provider);
  } catch {
    // 测试、隐私模式或无 localStorage 环境仍可通过事件对齐。
  }
  announceAgentIntent(provider, effort);
}
