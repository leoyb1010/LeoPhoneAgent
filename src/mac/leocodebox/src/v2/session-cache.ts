export function canClearCache(desktop?: { clearCache?: unknown } | null): boolean {
  return Boolean(desktop?.clearCache);
}

export function clearCacheLabel(): string {
  return '清掉缓存';
}

export function clearCacheToast(): string {
  return '已清掉缓存，正在刷新';
}
