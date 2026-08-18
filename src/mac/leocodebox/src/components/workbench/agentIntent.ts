/** 会话侧(useChatProviderState)监听的那条事件名 —— 只有它能改会话真正用的 provider。 */
export const AGENT_INTENT_EVENT = 'leocodebox-preferences:changed';

/**
 * 把「指挥条上此刻选中的 Agent(及推理强度)」宣告给会话侧。
 *
 * 为什么必须在回车那一刻再宣告一次:指挥条的芯片读的是 PreferencesContext,
 * 而真正决定请求走哪个 CLI 的是 useChatProviderState 里的 provider —— 两者是
 * 两份状态,只靠这条事件对齐。用户在会话之间点来点去时,composer 会跟随所选会话的
 * provider,把之前宣告过的意图冲掉;此时指挥条仍显示着用户选的 Agent,回车却按
 * 上一个会话的 provider 建会话。所以「新任务」这个入口在发起前必须重新宣告一次,
 * 而不是指望更早的某次宣告还活着。
 */
export function announceAgentIntent(provider: string, effort?: string): void {
  if (typeof window === 'undefined' || !provider) return;
  const detail: { defaultProvider: string; effort?: string } = { defaultProvider: provider };
  if (effort) detail.effort = effort;
  window.dispatchEvent(new CustomEvent(AGENT_INTENT_EVENT, { detail }));
}

/** ChatInterface 挂载时用来初始化 provider 的那把钥匙(useChatProviderState)。 */
const SELECTED_PROVIDER_KEY = 'selected-provider';

/**
 * 「下一个新会话用这个 Agent」—— 主控台按下开始时调这一个。
 *
 * 为什么光 announce 不够:主控台在 `dashboard` 分支里,MainContent 直接 return,
 * ChatInterface **根本没挂载**,那条事件夹在半空中没人听见。它是在切回会话那一刻
 * 才 `useState(readStoredProvider)` 初始化 provider 的,所以选择必须同时落到
 * localStorage 那把钥匙上,否则"在主控台选了 Codex"会在挂载那一刻悄悄变回默认值
 * —— 又是一次「选了 Codex,发出去还是 Claude」。
 *
 * 两条都发是有意的:会话已经挂着时走事件(立即生效),没挂着时走钥匙(挂载时生效)。
 */
export function commitAgentForNewSession(provider: string, effort?: string): void {
  if (!provider) return;
  try {
    localStorage.setItem(SELECTED_PROVIDER_KEY, provider);
  } catch {
    // 没有 localStorage(测试/隐私模式)时事件那条路仍然有效。
  }
  announceAgentIntent(provider, effort);
}

/**
 * 指挥条上的 Agent 芯片此刻代表谁,以及还能不能改。
 *
 * ── 为什么这里要"锁" ──────────────────────────────────────────────
 * 一个控件在两种语境下含义不同,就是歧义的定义。指挥条常驻在最上面,
 * 而它下面可能是主控台(还没有会话),也可能是一个**建会话时就把 Agent
 * 定死了**的已有会话。同一个下拉在前者是「给下一个新会话选 Agent」,在
 * 后者却看起来像「把这个会话换成别的 Agent」—— 而后者根本做不到:会话的
 * provider 在创建时写死,改的只是一个全局默认值。用户看到芯片写着 Codex、
 * 发出去还是 Claude,就是从这里长出来的。
 *
 * 所以:**选中了会话 → 芯片只显示这个会话的 Agent,不可选**(点它就回主控台
 * 开新任务);**没有选中会话(主控台 / 新会话)→ 芯片是选择器**,选的是
 * 「下一个新会话用谁」,这时候语义唯一。
 */
export function resolveCommandBarAgent({
  sessionProvider,
  preferredProvider,
}: {
  /** 当前选中会话建会话时定下的 provider;没有选中会话时传 null。 */
  sessionProvider?: string | null;
  /** 用户为"下一个新会话"选的 Agent(PreferencesContext)。 */
  preferredProvider: string;
}): { provider: string; locked: boolean } {
  const bound = typeof sessionProvider === 'string' ? sessionProvider.trim() : '';
  if (bound) return { provider: bound, locked: true };
  return { provider: preferredProvider, locked: false };
}
