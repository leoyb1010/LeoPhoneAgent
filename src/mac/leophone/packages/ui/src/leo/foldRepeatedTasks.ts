/**
 * [leo][up-sidebar] 侧栏里连着好几条同名任务（比如反复跑的「只回复两个字母：OK」）时，只显示最新一条，
 * 其余收成「还有 N 个同名任务」。正在打开 / 正在跑的任务永远单独显示，不会被藏起来。
 */
export type FoldedRun<T> = { item: T; hidden: T[]; runKey: string };

export function foldRepeatedTaskTitles<T extends { title: string }>(
  items: readonly T[],
  keyOf: (item: T) => string,
  keepVisible: (item: T) => boolean,
): FoldedRun<T>[] {
  const out: FoldedRun<T>[] = [];
  for (const item of items) {
    const last = out[out.length - 1];
    const title = item.title.trim();
    if (last && title && last.item.title.trim() === title && !keepVisible(item)) {
      last.hidden.push(item);
      continue;
    }
    out.push({ item, hidden: [], runKey: keyOf(item) });
  }
  return out;
}
