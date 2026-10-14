/**
 * [leo] 从 iPhone 导入后仍缺 Key 的供应商(iOS 导出默认不含密钥)。只用于在供应商卡片上把 Key 输入框标红,
 * 是纯界面提示,不是配置事实;用户开始输入 Key 即清除。
 */
const providersNeedingKey = new Set<string>();

export function markProvidersNeedingKey(providerIds: Iterable<string>): void {
  for (const providerId of providerIds) providersNeedingKey.add(providerId);
}

export function providerNeedsKeyAfterImport(providerId: string): boolean {
  return providersNeedingKey.has(providerId);
}

export function clearProviderNeedsKey(providerId: string): void {
  providersNeedingKey.delete(providerId);
}
