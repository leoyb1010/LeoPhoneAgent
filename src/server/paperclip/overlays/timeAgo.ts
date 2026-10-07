/** Chinese relative time with unchanged Date/string inputs and timezone semantics.
 *  1.1.7：与 lib/utils.ts 的 relativeTime 统一为“N 分钟前 / N 小时后”（数字与单位之间留空格），不再依赖 Intl 的无空格输出。 */
export function timeAgo(date: Date | string): string {
  const seconds = Math.round((new Date(date).getTime() - Date.now()) / 1000);
  if (!Number.isFinite(seconds)) return "时间未知";
  if (Math.abs(seconds) < 60) return "刚刚";
  const units: ReadonlyArray<readonly [string, number]> = [["个月", 2592000], ["周", 604800], ["天", 86400], ["小时", 3600], ["分钟", 60]];
  for (const [unit, size] of units) {
    if (Math.abs(seconds) >= size) {
      const n = Math.trunc(Math.abs(seconds) / size);
      return seconds < 0 ? `${n} ${unit}前` : `${n} ${unit}后`;
    }
  }
  return "刚刚";
}
