// OAuth 供应商的可选模型只来自运行时在登录后真正返回的列表。
// PRETTY_MODELS / MODEL_ARSENAL 是显示名和成本表,不能充当「登完就能用」的目录。
// 自定义兼容接口仍按用户写入的 id 列出。

export type CatalogModel = {
  id: string;
  name: string;
  reasoning: boolean;
  contextWindow: number | null;
};

export type RuntimeModel = {
  id: string;
  provider?: string;
  name?: string;
  reasoning?: boolean;
  contextWindow?: number;
};

export type ProviderCatalogAuth = {
  id: string;
  oauth: boolean;
  custom: boolean;
  configured: boolean;
};

export type CatalogRuntime = {
  getModels(providerId?: string): readonly RuntimeModel[];
  getAvailable(providerId?: string): Promise<readonly RuntimeModel[]>;
  refresh(options?: {
    allowNetwork?: boolean;
    providers?: readonly string[];
    force?: boolean;
    signal?: AbortSignal;
  }): Promise<unknown>;
};

export type DescribeRuntime = CatalogRuntime & {
  getProviderAuthStatus(id: string): { configured?: boolean } | null | undefined;
  hasConfiguredAuth(id: string): boolean;
  isUsingOAuth(id: string): boolean;
  isUsingSubscription(id: string): boolean;
  getRegisteredProviderConfig(id: string): { apiKey?: unknown; baseUrl?: unknown } | undefined;
};

export type ProviderLike = {
  id: string;
  name?: string;
  auth?: { oauth?: unknown };
};

export function serializeRuntimeModel(model: RuntimeModel): CatalogModel {
  return {
    id: model.id,
    name: model.name ?? model.id,
    reasoning: Boolean(model.reasoning),
    contextWindow: typeof model.contextWindow === 'number' ? model.contextWindow : null,
  };
}

/** 没登录、没密钥、也不是手录接口:空目录。已登录 / 已填密钥 / 自定义:原样映射运行时返回的那份,不补预设 id。 */
export function catalogFromRuntimeModels(
  provider: ProviderCatalogAuth,
  runtimeModels: readonly RuntimeModel[],
): CatalogModel[] {
  if (!provider.configured && !provider.custom) return [];
  return runtimeModels
    .filter((model) => !model.provider || model.provider === provider.id)
    .map(serializeRuntimeModel);
}

export function sketchProviderAuth(
  runtime: Pick<DescribeRuntime, 'getProviderAuthStatus' | 'hasConfiguredAuth' | 'isUsingOAuth' | 'isUsingSubscription' | 'getRegisteredProviderConfig'>,
  provider: ProviderLike,
  customIds: Set<string>,
  storedAuth: Record<string, 'api_key' | 'oauth'>,
): ProviderCatalogAuth & { usingOAuth: boolean; usingSubscription: boolean; status: unknown; name: string; baseUrl: string | null } {
  const id = provider.id;
  let status: unknown = null;
  try { status = runtime.getProviderAuthStatus(id); } catch { status = null; }
  const registered = runtime.getRegisteredProviderConfig(id);
  const inlineKey = Boolean(registered?.apiKey);
  const custom = customIds.has(id);
  const stored = storedAuth[id];
  const usingOAuth = runtime.isUsingOAuth(id) || stored === 'oauth';
  const configured = Boolean((status as { configured?: boolean } | null)?.configured)
    || runtime.hasConfiguredAuth(id)
    || inlineKey
    || (custom && Boolean(registered?.baseUrl))
    || Boolean(stored);
  return {
    id,
    name: typeof provider.name === 'string' ? provider.name : id,
    oauth: Boolean(provider.auth?.oauth) || usingOAuth,
    custom,
    configured,
    usingOAuth,
    usingSubscription: runtime.isUsingSubscription(id),
    status,
    baseUrl: custom && typeof registered?.baseUrl === 'string' ? registered.baseUrl : null,
  };
}

export async function refreshOAuthCatalogs(
  runtime: CatalogRuntime,
  providerIds: readonly string[],
  signal?: AbortSignal,
): Promise<void> {
  const ids = [...new Set(providerIds.filter(Boolean))];
  if (ids.length === 0) return;
  await runtime.refresh({ allowNetwork: true, providers: ids, force: true, signal });
}

/** 已登录的 OAuth:先向提供方刷新,再取 getAvailable();自定义 / 密钥走 getModels()(含用户手录 id)。 */
export async function loadRuntimeModelsForProvider(
  runtime: CatalogRuntime,
  provider: ProviderCatalogAuth,
  options?: { refreshOAuth?: boolean; signal?: AbortSignal },
): Promise<readonly RuntimeModel[]> {
  if (!provider.configured && !provider.custom) return [];
  if (provider.oauth && provider.configured) {
    if (options?.refreshOAuth !== false) {
      try {
        await refreshOAuthCatalogs(runtime, [provider.id], options?.signal);
      } catch {
        // 刷新失败仍读运行时当前列表,不回落到本地预设表。
      }
    }
    try {
      return await runtime.getAvailable(provider.id);
    } catch {
      return runtime.getModels(provider.id);
    }
  }
  return runtime.getModels(provider.id);
}

export async function describeProvider(
  runtime: DescribeRuntime,
  provider: ProviderLike,
  customIds: Set<string>,
  storedAuth: Record<string, 'api_key' | 'oauth'>,
  options?: { refreshOAuth?: boolean; signal?: AbortSignal },
): Promise<{
  id: string;
  name: string;
  oauth: boolean;
  custom: boolean;
  baseUrl: string | null;
  configured: boolean;
  usingOAuth: boolean;
  usingSubscription: boolean;
  status: unknown;
  models: CatalogModel[];
}> {
  const auth = sketchProviderAuth(runtime, provider, customIds, storedAuth);
  const runtimeModels = await loadRuntimeModelsForProvider(runtime, auth, options);
  return {
    id: auth.id,
    name: auth.name,
    oauth: auth.oauth,
    custom: auth.custom,
    baseUrl: auth.baseUrl,
    configured: auth.configured,
    usingOAuth: auth.usingOAuth,
    usingSubscription: auth.usingSubscription,
    status: auth.status,
    models: catalogFromRuntimeModels(auth, runtimeModels),
  };
}
