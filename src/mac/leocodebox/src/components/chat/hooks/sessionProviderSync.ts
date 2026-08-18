/**
 * 「当前会话的 provider」什么时候可以覆盖用户此刻选中的 Agent。
 *
 * 抽成纯函数是因为它就是 bug A 的修复点本身。原来的 effect 写成:
 *
 *   useEffect(() => {
 *     if (!selectedSession?.__provider || selectedSession.__provider === provider) return;
 *     setProvider(selectedSession.__provider);
 *     localStorage.setItem('selected-provider', selectedSession.__provider);
 *   }, [provider, selectedSession]);
 *
 * 依赖里带着 `provider`,于是只要 provider 一变它就重跑。用户在指挥条里把 Agent
 * 从 Claude 换成 Codex 时,preferences 事件先把 provider 置成 codex,紧接着这个
 * effect 就拿"你正开着的那个 Claude 会话"把它按回 claude,顺手还把全局默认
 * `selected-provider` 也写成了 claude。指挥条的芯片读的是 preferences,所以界面
 * 上照样显示 Codex、下拉里照样打勾 —— 表现就是「选了 Codex,发出去的还是 Claude」。
 *
 * 正确的判据是「有没有换到另一个会话」:只有会话身份变了,composer 才应该跟随那个
 * 会话的 provider(会话的 provider 是建会话时定死的,必须如实反映);在同一个会话上
 * 停留期间,用户的显式选择是唯一的意图来源,谁都不许改。
 *
 * 没有选中会话(新会话)时同样不动 provider —— 那个值正是「新会话要用哪个 Agent」。
 */
export type SessionProviderSyncState = {
  /** 上一次已经跟随过的会话 id(新会话为 null)。 */
  syncedSessionId: string | null;
  /** 当前选中的会话 id,新会话为 null。 */
  sessionId: string | null;
  /** 该会话建立时定下的 provider。 */
  sessionProvider: string | null | undefined;
  /** composer 此刻在用的 provider。 */
  provider: string;
};

export type SessionProviderSyncDecision =
  /** 还在同一个会话上:保留用户的选择,什么都不做。 */
  | 'keep'
  /** 换了会话,但没有可跟随的 provider(新会话)或已经一致:只更新记录。 */
  | 'track'
  /** 换到了另一个已有会话:跟随该会话的 provider。 */
  | 'follow';

export function decideSessionProviderSync({
  syncedSessionId,
  sessionId,
  sessionProvider,
  provider,
}: SessionProviderSyncState): SessionProviderSyncDecision {
  if (syncedSessionId === sessionId) return 'keep';
  if (!sessionProvider || sessionProvider === provider) return 'track';
  return 'follow';
}
