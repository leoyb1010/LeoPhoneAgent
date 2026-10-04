/** Chinese relative time with unchanged Date/string inputs and timezone semantics. */
export function timeAgo(date: Date | string): string {
  const seconds = Math.round((new Date(date).getTime() - Date.now()) / 1000);
  if (!Number.isFinite(seconds)) return "时间未知";
  if (Math.abs(seconds) < 60) return "刚刚";
  const rtf = new Intl.RelativeTimeFormat("zh-CN", { numeric: "always" });
  for (const [unit, size] of [["month", 2592000], ["week", 604800], ["day", 86400], ["hour", 3600], ["minute", 60]] as const) {
    if (Math.abs(seconds) >= size) return rtf.format(Math.trunc(seconds / size), unit);
  }
  return "刚刚";
}
