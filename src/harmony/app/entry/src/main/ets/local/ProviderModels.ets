export function skipUpstreamModels(type: string, credential: string): boolean {
  return type === 'openAI' && credential === 'oauth';
}

export function modelsAuthHeaders(type: string, key: string): Record<string, string> {
  if (type === 'gemini') {
    return {
      'x-goog-api-key': key,
      'Content-Type': 'application/json'
    };
  }
  if (type === 'anthropic') {
    return {
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json'
    };
  }
  return {
    'Authorization': `Bearer ${key}`,
    'Content-Type': 'application/json'
  };
}

export function modelsListUrl(root: string, type: string, key: string): string {
  const base = root.replace(/\/+$/, '');
  if (type === 'gemini') {
    const join = base.indexOf('?') >= 0 ? '&' : '?';
    return `${base}/models${join}key=${encodeURIComponent(key)}`;
  }
  return `${base}/models`;
}

export function modelIdsFromListJson(json: object): string[] {
  const obj = json as Record<string, Object>;
  const ids: string[] = [];
  const data = obj['data'];
  if (Array.isArray(data)) {
    for (let i = 0; i < data.length; i++) {
      const item = data[i] as Record<string, Object>;
      const id = `${item['id'] ?? ''}`.trim();
      if (id.length > 0) {
        ids.push(id);
      }
    }
  }
  const models = obj['models'];
  if (Array.isArray(models)) {
    for (let i = 0; i < models.length; i++) {
      const item = models[i] as Record<string, Object>;
      const name = `${item['name'] ?? item['id'] ?? ''}`.trim();
      if (name.length > 0) {
        ids.push(name.replace(/^models\//, ''));
      }
    }
  }
  return uniqueIds(ids);
}

export function modelsDevProviderKey(type: string): string {
  if (type === 'openAI') {
    return 'openai';
  }
  if (type === 'anthropic') {
    return 'anthropic';
  }
  if (type === 'gemini') {
    return 'google';
  }
  if (type === 'xAI') {
    return 'xai';
  }
  if (type === 'kimiCode') {
    return 'moonshotai';
  }
  if (type === 'openRouter') {
    return 'openrouter';
  }
  return '';
}

export const MODELS_DEV_URL: string = 'https://models.dev/api.json';

export function idsFromModelsDevJson(json: object, providerKey: string): string[] {
  if (!providerKey) {
    return [];
  }
  const root = json as Record<string, Object>;
  const provider = root[providerKey] as Record<string, Object> | undefined;
  if (!provider) {
    return [];
  }
  const models = provider['models'] as Record<string, Object> | undefined;
  if (!models) {
    return [];
  }
  return uniqueIds(Object.keys(models));
}

function uniqueIds(ids: string[]): string[] {
  const seen: string[] = [];
  for (let i = 0; i < ids.length; i++) {
    if (seen.indexOf(ids[i]) < 0) {
      seen.push(ids[i]);
    }
  }
  return seen;
}
