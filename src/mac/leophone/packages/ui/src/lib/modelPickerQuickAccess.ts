import { rankModelSearch } from "@/lib/modelSearchScorer.js";

/** 常用（置顶）上限，与 iOS `ModelSwitcher.maxPinned` 一致。 */
export const MODEL_PICKER_MAX_PINNED = 8;
/** 快速区展示的最近使用数量。 */
export const MODEL_PICKER_RECENT_VISIBLE = 3;
/** 最近使用落盘数量：多存几条，过滤掉不可用模型后仍能凑满展示数量。 */
export const MODEL_PICKER_RECENT_STORED = 10;

export interface ModelPickerItemLike {
  value: string;
  name: string;
  modelId?: string;
}

export interface ModelPickerGroupLike<TItem extends ModelPickerItemLike> {
  label: string;
  items: readonly TItem[];
}

export interface ModelPickerEntry<TItem extends ModelPickerItemLike> {
  item: TItem;
  /** 所属分组（服务商）名称；`leadingItems` 为空串。 */
  groupLabel: string;
}

/** 按菜单展示顺序拍平所有可选模型；同一 value 只保留第一次出现。 */
export function flattenModelPickerEntries<TItem extends ModelPickerItemLike>(
  groups: readonly ModelPickerGroupLike<TItem>[],
  leadingItems: readonly TItem[] = [],
): ModelPickerEntry<TItem>[] {
  const seen = new Set<string>();
  const entries: ModelPickerEntry<TItem>[] = [];
  const push = (item: TItem, groupLabel: string) => {
    if (seen.has(item.value)) return;
    seen.add(item.value);
    entries.push({ item, groupLabel });
  };
  for (const item of leadingItems) push(item, "");
  for (const group of groups) {
    for (const item of group.items) push(item, group.label);
  }
  return entries;
}

export function rankModelPickerEntries<TItem extends ModelPickerItemLike>(
  entries: readonly ModelPickerEntry<TItem>[],
  query: string,
): ModelPickerEntry<TItem>[] {
  return rankModelSearch(entries, query, ({ item, groupLabel }) => ({
    displayName: item.name,
    baseDisplayName: item.name,
    modelId: item.modelId ?? item.name,
    providerLabel: groupLabel,
  }));
}

/** 设置里读出的列表做一次防御：只留非空字符串、去重、截断。 */
export function sanitizeModelValueList(value: unknown, limit: number): string[] {
  if (!Array.isArray(value)) return [];
  const result: string[] = [];
  for (const candidate of value) {
    if (typeof candidate !== "string" || !candidate || result.includes(candidate)) continue;
    result.push(candidate);
    if (result.length >= limit) break;
  }
  return result;
}

export type TogglePinnedResult =
  | { status: "pinned" | "unpinned"; pinned: string[] }
  | { status: "full"; pinned: string[] };

/** 置顶追加到末尾；取消置顶保持其他顺序；已满时不改动并返回 full。 */
export function togglePinnedModel(
  pinned: readonly string[],
  value: string,
  max: number = MODEL_PICKER_MAX_PINNED,
): TogglePinnedResult {
  if (pinned.includes(value)) {
    return { status: "unpinned", pinned: pinned.filter((candidate) => candidate !== value) };
  }
  if (pinned.length >= max) {
    return { status: "full", pinned: [...pinned] };
  }
  return { status: "pinned", pinned: [...pinned, value] };
}

/** 发送后把模型提到最前，去重并截断。 */
export function recordRecentModel(
  recent: readonly string[],
  value: string,
  limit: number = MODEL_PICKER_RECENT_STORED,
): string[] {
  if (!value) return [...recent];
  return [value, ...recent.filter((candidate) => candidate !== value)].slice(0, limit);
}

export function isSameModelValueList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

/**
 * 解析快速区：只保留当前仍可选的模型（不在分组里 = 供应商禁用 / 缺 Key / 已删除，直接不展示）。
 * 最近使用排除已置顶的模型，取前 `recentLimit` 个。
 */
export function resolveQuickAccessEntries<TItem extends ModelPickerItemLike>(
  entries: readonly ModelPickerEntry<TItem>[],
  pinnedValues: readonly string[],
  recentValues: readonly string[],
  recentLimit: number = MODEL_PICKER_RECENT_VISIBLE,
): { pinned: ModelPickerEntry<TItem>[]; recent: ModelPickerEntry<TItem>[] } {
  const byValue = new Map(entries.map((entry) => [entry.item.value, entry]));
  const pinned = pinnedValues.flatMap((value) => {
    const entry = byValue.get(value);
    return entry ? [entry] : [];
  });
  const pinnedSet = new Set(pinned.map((entry) => entry.item.value));
  const recent: ModelPickerEntry<TItem>[] = [];
  for (const value of recentValues) {
    if (recent.length >= recentLimit) break;
    const entry = byValue.get(value);
    if (!entry || pinnedSet.has(value) || recent.includes(entry)) continue;
    recent.push(entry);
  }
  return { pinned, recent };
}
