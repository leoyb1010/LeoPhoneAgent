/**
 * [leo][wp-31] 新回合进入动效(opacity + translateY 6px,dur.2)只该在「刚开始的回合」第一次挂载时播一次。
 * 时间线是虚拟列表,滚出视口再滚回来会重新挂载;历史回合、重开会话时已结束的回合也不该再动。
 * 这里按回合 key 记一笔,上限之外丢最早的,避免长会话里无限增长。
 */
const MAX_PLAYED_TURN_KEYS = 400;
const playedTurnKeys = new Set<string>();

export function claimLeoTurnEnter(
  turnKey: string,
  isLastTurn: boolean,
  isRunning: boolean,
): boolean {
  if (!isLastTurn || !isRunning || playedTurnKeys.has(turnKey)) return false;
  playedTurnKeys.add(turnKey);
  if (playedTurnKeys.size > MAX_PLAYED_TURN_KEYS) {
    const oldest = playedTurnKeys.values().next().value;
    if (oldest !== undefined) playedTurnKeys.delete(oldest);
  }
  return true;
}

/** 仅测试用。 */
export function resetLeoTurnEnterForTest(): void {
  playedTurnKeys.clear();
}
