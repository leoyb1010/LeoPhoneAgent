/**
 * 指挥条回车 → 新会话首条消息的「什么时候可以真的发出去」判据。
 *
 * 单独抽出来是因为它是 bug 的修复点本身:AppContent 先调 handleNewSession
 * (清 selectedSession / bump newSessionTrigger / navigate),再**同步**派发
 * handoff-draft。同步 submit 时 React 还没重渲染,会话还挂在上一个 id 上,
 * 这一句就会打进旧会话,用户则被带到新会话的空态页("选择您的 AI 助手")。
 *
 * 所以必须等两个 id 都归零 —— 父层的 selectedSession(handleNewSession 清)
 * 和会话内的 currentSessionId(useChatSessionState 的 newSessionTrigger reset 清)
 * —— 之后再发,handleSubmit 才会走"申请一个新 sessionId"的分支。
 */
export type HandoffAutoSendState = {
  /** 收到 `send: true` 的草稿后置位,发出去(或作废)后清掉。 */
  armed: boolean;
  /** 父层当前选中的会话 id。 */
  selectedSessionId: string | null;
  /** 会话内本地记录的会话 id(新会话建立后先落在这里)。 */
  currentSessionId: string | null;
  /** 当前输入框内容。 */
  draft: string;
};

export type HandoffAutoSendDecision = 'wait' | 'send' | 'drop';

export function decideHandoffAutoSend({
  armed,
  selectedSessionId,
  currentSessionId,
  draft,
}: HandoffAutoSendState): HandoffAutoSendDecision {
  if (!armed) return 'wait';
  // 还挂在某个会话上 —— 新会话状态没落定,再等一帧。
  if (selectedSessionId || currentSessionId) return 'wait';
  // 草稿被清空(用户自己删了、或已被别的路径发走):作废,别凭空发一条空消息。
  if (!draft.trim()) return 'drop';
  return 'send';
}
