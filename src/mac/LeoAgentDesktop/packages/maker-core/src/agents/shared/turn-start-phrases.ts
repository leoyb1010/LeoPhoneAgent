/**
 * turn-start status 的暖心文案池 — 各 agent 在 send() 入口立刻 push 一条 status
 * event 让 UI 状态条一发就亮 (避免从 send 到 SDK 第一个事件之间的 gap statusbar 全黑)。
 *
 * 文案与"agent 是 Claude 还是 Codex"无关, 抽到 shared 让所有 agent 复用同一份词库,
 * 行为一致 (随机一句 / 缺省 fallback) 且未来加新 agent 可直接复用。
 *
 * 词库分两类:
 *  - RECURRING_PHRASES: 暖心话, 每 turn 都可被抽 (无去重)。
 *  - ONE_SHOT_PHRASES:  功能引导, 单 session 出现次数有限 + 阶梯式 pity 保底。
 *    `guarantees = [10, 20, 30]` 表示该 tip 单 session 出现 3 次, 第 i 次出现的
 *    保底为 guarantees[i] (即"自上次展示后已候选 N 个 turn 仍未抽到则强制展示")。
 *    /clear 在产品上等价于"开新 session" (见 desktop builtins.ts), agent handle
 *    随之重建, OneShotState 自然清零, 不需要额外 reset 钩子。
 */

const RECURRING_PHRASES: Array<(name: string) => string> = [
  (n) => `Nice day, ${n}!`,
  (n) => `Hey ${n}, here we go`,
  (n) => `${n}, sit tight`,
  (n) => `Crafting for ${n}...`,
  (n) => `${n}, on it`,
  (n) => `Brewing magic for ${n}...`,
  (n) => `Take a breath, ${n}`,
  (n) => `Let's go, ${n}!`,
  (n) => `${n}, leave it to me`,
  (n) => `Working on it, ${n}`,
];

/**
 * 单 session 中出现次数受限 + 带阶梯 pity 保底的"功能引导"型 tip。
 * - id: 稳定字符串 (不是文案本身), 后续微调文案不影响 session 内"已展示次数"计数。
 * - guarantees: 长度 = 单 session 允许出现总次数; guarantees[i] = 第 i 次出现的保底
 *   候选轮次数。该 tip 已被展示 N 次 (N < guarantees.length) 时, 当前保底门槛为
 *   guarantees[N]; 自上次展示以来候选轮次 ≥ 该门槛则强制展示。展示满 length 次后
 *   该 tip 彻底退出抽样池。
 */
interface OneShotPhrase {
  id: string;
  guarantees: number[];
  build: (name: string) => string;
}

const ONE_SHOT_PHRASES: OneShotPhrase[] = [
  {
    id: 'tip:issue-panel',
    guarantees: [10, 20, 30],
    build: (n) => `${n},试试 /issue 给我们提反馈或建议`,
  },
];

export interface TurnStartPick {
  /** 最终展示的文案 (已拼好用户名) */
  text: string;
  /** 抽中 one-shot 时的稳定 id; 调用方应:
   *   1. state.displayed[id] += 1 — 推进保底阶梯 (满额后自动退出抽样池)
   *   2. state.pity.delete(id)    — 重置 pity 计数, 下一次出现独立累计 */
  oneShotId?: string;
}

/**
 * 调用方持有的 one-shot 状态 (per session, 挂在 agent handle closure 上)。
 * - displayed: id → 已展示次数; ≥ 对应 guarantees.length 时退出抽样池
 * - pity:      id → 自上次展示以来已候选轮次 (本次未展示也算累积一次)
 */
export interface OneShotState {
  displayed: Map<string, number>;
  pity: Map<string, number>;
}

/**
 * 抽一条 turn-start 文案。
 *
 * 抽样规则:
 *   1. 缺用户名 → 'Just Wait ...' 兜底, 不动 oneShotState (异常上下文不投放引导)。
 *   2. 计算 available one-shots (= 展示次数未满额的 ONE_SHOT_PHRASES); 对每个 pity+1。
 *   3. 若任一 available 的 pity 已达当前阶梯保底 → 强制展示其中"超出保底最多"的那条
 *      (按 pity − threshold 倒序; 多条同时触发时优先满足"等得最久"的)。
 *   4. 否则在 recurring + available 间等权抽样。
 *
 * @param userName 用户展示名
 * @param oneShotState 当前 session 的 one-shot 状态; 函数会 mutate 内部 pity Map。
 *                     不传则不投放任何 one-shot (兼容无状态的临时调用场景)。
 */
export function pickTurnStartStatus(
  userName: string | undefined,
  oneShotState?: OneShotState,
): TurnStartPick {
  const name = userName?.trim();
  if (!name) return { text: 'Just Wait ...' };

  const available = oneShotState
    ? ONE_SHOT_PHRASES.filter(
        (p) => (oneShotState.displayed.get(p.id) ?? 0) < p.guarantees.length,
      )
    : [];

  // 本 turn 进入候选 → 所有 available 的 pity +1。
  // 即使本 turn 抽到的是 recurring, available 的 pity 也算累积一次 (没投出 = 一次未中)。
  if (oneShotState) {
    for (const p of available) {
      oneShotState.pity.set(p.id, (oneShotState.pity.get(p.id) ?? 0) + 1);
    }
  }

  // 保底命中: 当前阶梯门槛 = guarantees[已展示次数];
  // 多条同时触发选超出保底最多 (pity − threshold 最大) 的 — 等得最久者优先。
  if (oneShotState) {
    const thresholdOf = (p: OneShotPhrase): number =>
      p.guarantees[oneShotState.displayed.get(p.id) ?? 0];
    const guaranteed = available
      .filter((p) => (oneShotState.pity.get(p.id) ?? 0) >= thresholdOf(p))
      .sort((a, b) => {
        const overshootB = (oneShotState.pity.get(b.id) ?? 0) - thresholdOf(b);
        const overshootA = (oneShotState.pity.get(a.id) ?? 0) - thresholdOf(a);
        return overshootB - overshootA;
      });
    if (guaranteed.length > 0) {
      const picked = guaranteed[0];
      return { text: picked.build(name), oneShotId: picked.id };
    }
  }

  // 等权抽样 (recurring + 未保底的 available)。
  type Candidate = { build: (n: string) => string; oneShotId?: string };
  const pool: Candidate[] = [
    ...RECURRING_PHRASES.map<Candidate>((build) => ({ build })),
    ...available.map<Candidate>((p) => ({ build: p.build, oneShotId: p.id })),
  ];
  const picked = pool[Math.floor(Math.random() * pool.length)];
  return {
    text: picked.build(name),
    ...(picked.oneShotId ? { oneShotId: picked.oneShotId } : {}),
  };
}
