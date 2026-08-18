/**
 * 新会话的「第一句话」—— 和会话重置同源下发的一份状态。
 *
 * ── 为什么是这个形状,而不是继续等时序 ────────────────────────────
 * 这个 bug 修过两轮,两轮都栽在同一个地方:草稿走的是「全局事件 + ref」
 * (`leocodebox:handoff-draft`)这条独立的异步流,而会话重置走的是
 * `newSessionTrigger` 另一条流。两条流没有共同的真源,于是:
 *
 * 1) 主控台按下开始时 `MainContent` 还停在 `dashboard` 分支,ChatInterface
 *    **根本没挂载** —— 那个同步派发的事件夹在半空中没人听见,这句话当场蒸发。
 *    (ChatInterface 还是 React.lazy 的,首次进会话页也要等 chunk 落地。)
 * 2) 即使听见了,文本落在 `inputValueRef` 里,而新会话 reset 会清空 composer,
 *    ref 被冲掉 → 补发时判据读到空串 → 判定作废 → 内容还是凭空消失。
 * 3) 「先建会话、等状态、再补发」这条流程中间必然渲染一帧空会话,那一帧就是
 *    用户看到的「选择您的 AI 助手」空态页 —— 明明已经选好了 Agent,还要再选一次。
 *
 * 所以这里不再"等时序",而是把第一句话变成新会话状态的一部分:
 * `handleNewSession(project, prompt)` 在同一批 setState 里既 bump
 * `newSessionTrigger` 也放下 `pendingPrompt`。composer 挂载(或 reset 完成)后
 * 从 props 读它、消费它。事件到不到、ref 有没有被冲,都不再影响结果。
 *
 * slot 用可变对象而不是 state 保存真值:消费必须是**同步且只有一次**的。
 * 如果只靠 `setPendingPrompt(null)` 来清,同一拍里跑两遍 effect(StrictMode
 * 双调用、或 reset 与挂载撞在一起)就会读到同一个尚未清空的 state,把这句话
 * 发两遍。ref 让"取值即清空"在读的那一刻就完成。
 */

export type PendingPromptSlot = {
  /** 放下一条待发的首句;空白视为没有(空输入不该建会话、更不该发空消息)。 */
  set: (prompt: string | null | undefined) => void;
  /** 取值并同步清空 —— 同一条 prompt 永远只会被取走一次。 */
  consume: () => string | null;
  /** 只看不取,给渲染层判断"是不是正在开始一个新会话"。 */
  peek: () => string | null;
};

export function createPendingPromptSlot(): PendingPromptSlot {
  let pending: string | null = null;
  return {
    set(prompt) {
      pending = typeof prompt === 'string' && prompt.trim() ? prompt : null;
    },
    consume() {
      const value = pending;
      pending = null;
      return value;
    },
    peek() {
      return pending;
    },
  };
}

export type PendingPromptSendState = {
  /** 父层挂在新会话上的首句(null = 没有待发的)。 */
  pendingPrompt: string | null;
  /** 父层当前选中的会话 id。 */
  selectedSessionId: string | null;
  /** 会话内本地记录的会话 id(新会话 reset 后应为 null)。 */
  currentSessionId: string | null;
  /** 有没有可落脚的项目 —— 没有项目 handleSubmit 会直接 return。 */
  hasProject: boolean;
};

export type PendingPromptSendDecision = 'wait' | 'send' | 'drop';

/**
 * 什么时候可以把首句真的发出去。
 *
 * 判据只看状态,不看"事件到没到":两个 id 都归零 = 新会话 reset 已落定,
 * 这时 `handleSubmit` 才会走"向网关申请一个新 sessionId"的分支;否则这一句
 * 会打进用户刚才看的那个会话。
 */
export function decidePendingPromptSend({
  pendingPrompt,
  selectedSessionId,
  currentSessionId,
  hasProject,
}: PendingPromptSendState): PendingPromptSendDecision {
  if (pendingPrompt === null) return 'wait';
  // 空白首句不建会话、不发消息(指挥条留空回车走到这里也必须无害)。
  if (!pendingPrompt.trim()) return 'drop';
  // 没有项目就发不出去,但也别把这句话丢了 —— 等项目落定。
  if (!hasProject) return 'wait';
  // 还挂在某个会话上:新会话状态没落定,再等一帧。
  if (selectedSessionId || currentSessionId) return 'wait';
  return 'send';
}
