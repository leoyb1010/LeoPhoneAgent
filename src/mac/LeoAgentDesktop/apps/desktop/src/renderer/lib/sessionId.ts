/**
 * sessionId — UUID 展示辅助。
 *
 * 把 UUID 截成 `83639512…7ed0` 形式,用于 sidebar / handoff card / pill 等
 * 不能放完整 36 字符的小窄位。`…` 用 horizontal ellipsis 而非三个英文点,
 * 视觉上更紧凑且无歧义(三个点容易被误读成 ASCII `...`)。
 */
export function shortSessionId(sessionId: string): string {
  if (sessionId.length <= 13) return sessionId;
  return `${sessionId.slice(0, 8)}…${sessionId.slice(-4)}`;
}
