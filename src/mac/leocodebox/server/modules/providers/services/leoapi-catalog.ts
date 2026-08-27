import type { LLMProvider, ProviderModelsDefinition } from '@/shared/types.js';
import { sanitizeIdPart, type SwitchProvider } from '@/modules/leocodebox/index.js';

type LeoapiStoreSlice = {
  activeByTarget?: Partial<Record<string, string>>;
  providers?: Array<Pick<SwitchProvider, 'id' | 'name' | 'model' | 'discoveredModels'>>;
};

const LEOAPI_CATALOG_TARGETS = new Set<LLMProvider>(['claude', 'codex', 'opencode']);

export function extrasFromActiveLeoapi(
  provider: LLMProvider,
  store: LeoapiStoreSlice,
): { extras: string[]; label?: string } {
  if (!LEOAPI_CATALOG_TARGETS.has(provider)) return { extras: [] };
  const activeId = store.activeByTarget?.[provider];
  const active = activeId ? store.providers?.find((item) => item.id === activeId) : undefined;
  if (!active) return { extras: [] };

  const extras: string[] = [];
  const seen = new Set<string>();
  const push = (id?: string) => {
    const value = id?.trim();
    if (!value || seen.has(value)) return;
    seen.add(value);
    extras.push(value);
  };
  if (provider === 'opencode' && active.model) {
    push(`leocodebox_${sanitizeIdPart(active.id)}/${active.model}`);
  }
  push(active.model);
  for (const id of active.discoveredModels || []) push(id);
  return { extras, label: active.name || 'Leoapi' };
}

export function mergeLeoapiOptions(
  catalog: ProviderModelsDefinition,
  extras: string[],
  sourceLabel?: string,
): ProviderModelsDefinition {
  const existing = new Set(catalog.OPTIONS.map((option) => option.value));
  const added: ProviderModelsDefinition['OPTIONS'] = [];
  for (const raw of extras) {
    const id = raw.trim();
    if (!id || existing.has(id)) continue;
    existing.add(id);
    added.push({
      value: id,
      label: id,
      description: sourceLabel || 'Leoapi',
    });
  }
  if (added.length === 0) return catalog;
  return { ...catalog, OPTIONS: [...added, ...catalog.OPTIONS] };
}
