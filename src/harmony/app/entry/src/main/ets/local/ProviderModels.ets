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
  if (type === 'openCodeGo') return 'opencode-go';
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

export const CODEX_MODELS_URL: string = 'https://chatgpt.com/backend-api/codex/models';

/**
 * ChatGPT 登录(Codex)的模型目录 {models:[{slug, visibility, priority}]} → 可列出的 slug,按 priority 排。
 * 和 iOS 同一个来源(Codex CLI 用的那份);服务端隐藏的(visibility 不是 list)不列。
 */
export function codexCatalogIds(json: object): string[] {
  const rows = (json as Record<string, Object>)['models'];
  if (!Array.isArray(rows)) {
    return [];
  }
  const listed: Record<string, Object>[] = [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i] as Record<string, Object>;
    const visibility = `${row['visibility'] ?? 'list'}`;
    if (visibility === 'list' && `${row['slug'] ?? ''}`.length > 0) {
      listed.push(row);
    }
  }
  listed.sort((a: Record<string, Object>, b: Record<string, Object>): number =>
    Number(a['priority'] ?? Number.MAX_SAFE_INTEGER) - Number(b['priority'] ?? Number.MAX_SAFE_INTEGER));
  return uniqueIds(listed.map((row: Record<string, Object>) => `${row['slug']}`));
}

/** The actual provider wire follows iOS OpenCodeGoWireProtocol, including catalog npm overrides. */
export function openCodeWire(model: string, metadata: string = ''): string {
  try {
    const entry = JSON.parse(metadata || '{}') as Record<string, Object>; const provider = entry['provider'] as Record<string, Object> | undefined;
    const npm = `${provider?.['npm'] ?? ''}`.toLowerCase();
    if (npm === '@ai-sdk/anthropic') return 'anthropic';
    if (npm === '@ai-sdk/openai') return 'responses';
    if (npm === '@ai-sdk/openai-compatible') return 'openai';
  } catch (_error) {}
  const id = model.toLowerCase().split('/').pop() ?? model.toLowerCase();
  if (['gpt-', 'grok-', 'muse-spark-'].some((prefix: string) => id.startsWith(prefix))) return 'responses';
  return ['minimax-', 'qwen'].some((prefix: string) => id.startsWith(prefix)) ? 'anthropic' : 'openai';
}
// /models 里还挂着、一调用就回 "Model is unavailable" 的下线模型(2026-09-27 实测),不给选。
const OPENCODE_GO_RETIRED: string[] =
  ['kimi-k2.5', 'glm-5', 'qwen3.5-plus', 'mimo-v2-pro', 'mimo-v2-omni', 'hy3-preview', 'grok-4.5'];

export function chatModelsFor(type: string, ids: string[]): string[] {
  if (type !== 'openCodeGo') {
    return ids;
  }
  const kept: string[] = ids.filter((id: string) => {
    const parts = id.toLowerCase().split('/');
    const bare = parts[parts.length - 1];
    if (OPENCODE_GO_RETIRED.includes(bare)) {
      return false;
    }
    return true;
  });
  return kept;
}

/** Output capability follows catalog metadata, with the same known-family fallback used by older archives. */
export function modelImageMode(model: string, metadata: string = '', type: string = ''): string {
  const id = model.toLowerCase().split('/').pop() ?? model.toLowerCase();
  let image = /(?:gpt-image|chatgpt-image|dall-e|dalle|imagen|flash-image|pro-image|image-preview|image-generation|image-gen|gpt-5(?:\.\d+)?-image)/.test(id);
  let text = !/^(?:gpt-image|chatgpt-image|dall-e|dalle|imagen)/.test(id);
  if (metadata) {
    try {
      const info = JSON.parse(metadata) as Record<string, Object>;
      const override = info['modalityOverride'];
      const bits = typeof override === 'number' ? override : Number((override as Record<string, Object>)?.['rawValue'] ?? 0);
      if (override !== undefined && override !== null) { image = (bits & 64) !== 0; text = (bits & 2) !== 0; }
      const modalities = info['modalities'] as Record<string, Object> | undefined;
      const architecture = info['architecture'] as Record<string, Object> | undefined;
      const output = modalities?.['output'] ?? architecture?.['output_modalities'];
      if (Array.isArray(output)) { image = output.indexOf('image') >= 0; text = output.indexOf('text') >= 0; }
    } catch (_error) { /* Legacy hand-entered model IDs still use their known family. */ }
  }
  if (!image) return '';
  return !text && type !== 'gemini' && type !== 'openRouter' ? 'images' : 'multimodal';
}

export function modelMetadataFromList(json: object, providerKey: string = ''): Record<string, string> {
  const body = json as Record<string, Object>; const output: Record<string, string> = {};
  const provider = body[providerKey] as Record<string, Object> | undefined;
  const source = providerKey ? provider?.['models'] : (body['data'] ?? body['models']);
  if (Array.isArray(source)) {
    const rows = source as Object[];
    for (const entry of rows) {
      const item = entry as Record<string, Object>; const id = `${item['id'] ?? item['name'] ?? ''}`.replace(/^models\//, '');
      if (id) output[id] = JSON.stringify(item);
    }
  } else if (source && typeof source === 'object') {
    const entries = source as Record<string, Object>; const keys = Object.keys(entries);
    for (const id of keys) output[id] = JSON.stringify(entries[id]);
  }
  return output;
}
