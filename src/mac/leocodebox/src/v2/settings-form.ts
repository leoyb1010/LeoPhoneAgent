export const CUSTOM_API_CHOICES = [
  { id: 'openai-completions', label: 'OpenAI Chat Completions' },
  { id: 'openai-responses', label: 'OpenAI Responses' },
  { id: 'anthropic-messages', label: 'Anthropic Messages' },
] as const;

export type CustomProviderDraft = {
  id: string;
  name: string;
  baseUrl: string;
  api: string;
  modelId: string;
  modelName: string;
  key: string;
};

export function emptyCustomDraft(): CustomProviderDraft {
  return { id: '', name: '', baseUrl: '', api: 'openai-completions', modelId: '', modelName: '', key: '' };
}

export function customIdOk(id: string): boolean {
  return /^[a-z][a-z0-9-]{1,40}$/.test(id.trim().toLowerCase());
}

export function customUrlOk(raw: string): boolean {
  try {
    const url = new URL(raw.trim());
    return (url.protocol === 'http:' || url.protocol === 'https:') && url.hostname !== '' && url.hostname !== '0.0.0.0';
  } catch {
    return false;
  }
}

export function customDraftReady(draft: CustomProviderDraft): boolean {
  return customIdOk(draft.id) && customUrlOk(draft.baseUrl) && Boolean(draft.modelId.trim());
}

export function filterCatalog<T extends { id: string; name?: string }>(models: T[], query: string): T[] {
  const q = query.trim().toLowerCase();
  if (!q) return models;
  return models.filter((m) => `${m.id} ${m.name ?? ''}`.toLowerCase().includes(q));
}

export function summarizeModels(models: Array<{ name: string }>, limit = 3): string {
  if (models.length === 0) return '—';
  const head = models.slice(0, limit).map((m) => m.name).join(' · ');
  return models.length > limit ? `${head} +${models.length - limit}` : head;
}

export function summarizeProviderModels(provider: { oauth?: boolean; configured: boolean; custom?: boolean; models: Array<{ name: string }> }, limit = 3): string {
  if (!provider.configured && !provider.custom) {
    return provider.oauth ? '登录后从提供方读取' : '填密钥后从提供方读取';
  }
  if (provider.models.length > 0) return summarizeModels(provider.models, limit);
  if (provider.oauth && provider.configured) return '提供方未返回模型';
  return '—';
}

export type UsableProviderModel = {
  provider: string;
  providerName: string;
  id: string;
  name: string;
  reasoning?: boolean;
  contextWindow?: number | null;
};

/** 没登录时先看见这几家。id 对不上的仍按名字排,不会被丢掉。openai-codex 是 ChatGPT 订阅登录,不是 API 密钥那条 openai。 */
export const FIRST_LOGIN_PROVIDER_IDS = [
  'openai-codex', 'anthropic', 'github-copilot', 'openrouter', 'xai', 'kimi-coding', 'openai', 'google', 'minimax',
] as const;

/** 设置首页:已登录 + 常用入口。其余靠「找供应商」或「更多」。 */
export function providersShownBeforeMore<T extends { id: string; name: string; configured: boolean }>(
  ranked: readonly T[],
  query: string,
  showAll: boolean,
): { shown: T[]; hidden: number } {
  const matched = filterProviders(ranked, query);
  if (query.trim() || showAll) return { shown: matched, hidden: 0 };
  const first = new Set<string>(FIRST_LOGIN_PROVIDER_IDS);
  const shown = matched.filter((provider) => provider.configured || first.has(provider.id));
  return { shown, hidden: Math.max(0, matched.length - shown.length) };
}

export function rankProvidersForLogin<T extends { id: string; name: string; configured: boolean }>(providers: readonly T[]): T[] {
  return [...providers].sort((a, b) => {
    const configured = Number(b.configured) - Number(a.configured);
    if (configured !== 0) return configured;
    const ai = (FIRST_LOGIN_PROVIDER_IDS as readonly string[]).indexOf(a.id);
    const bi = (FIRST_LOGIN_PROVIDER_IDS as readonly string[]).indexOf(b.id);
    const ar = ai === -1 ? FIRST_LOGIN_PROVIDER_IDS.length : ai;
    const br = bi === -1 ? FIRST_LOGIN_PROVIDER_IDS.length : bi;
    if (ar !== br) return ar - br;
    return a.name.localeCompare(b.name, 'zh');
  });
}

export function filterProviders<T extends { id: string; name: string }>(providers: readonly T[], query: string): T[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...providers];
  return providers.filter((provider) => `${provider.id} ${provider.name}`.toLowerCase().includes(q));
}

/** 选择器 / ⌘K / 默认模型只吃已配置供应商的运行时目录,不读本地预设 id 表。 */
export function usableModelsFromProviders<
  P extends { id: string; name: string; configured: boolean; models: Array<{ id: string; name: string; reasoning?: boolean; contextWindow?: number | null }> },
>(providers: readonly P[]): UsableProviderModel[] {
  return providers.filter((p) => p.configured).flatMap((p) => p.models.map((m) => ({
    provider: p.id,
    providerName: p.name,
    id: m.id,
    name: m.name,
    reasoning: m.reasoning,
    contextWindow: m.contextWindow,
  })));
}
