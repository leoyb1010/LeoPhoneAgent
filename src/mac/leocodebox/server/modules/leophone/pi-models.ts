import fs from 'node:fs';
import path from 'node:path';

import { PI_MODELS_PATH, ensureDirs } from './pi-runtime.js';

// 用户自己录入的 OpenAI / Anthropic 兼容接口,落在 pi 的 models.json。
// 密钥不写进这个文件:走 auth.json(setApiKey)。这里只存可达的地址和模型目录。

export const CUSTOM_APIS = ['openai-completions', 'openai-responses', 'anthropic-messages'] as const;
export type CustomApi = (typeof CUSTOM_APIS)[number];

export type ModelsJsonModel = {
  id: string;
  name?: string;
  api?: string;
  baseUrl?: string;
  reasoning?: boolean;
  input?: Array<'text' | 'image'>;
  contextWindow?: number;
  maxTokens?: number;
  cost?: { input: number; output: number; cacheRead: number; cacheWrite: number };
};

export type ModelsJsonProvider = {
  name?: string;
  baseUrl?: string;
  api?: string;
  apiKey?: string;
  headers?: Record<string, string>;
  models?: ModelsJsonModel[];
};

export type ModelsJsonFile = { providers: Record<string, ModelsJsonProvider> };

export class ModelsJsonError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ModelsJsonError';
  }
}

const ID_RE = /^[a-z][a-z0-9-]{1,40}$/;

export function assertProviderId(id: string): string {
  const next = String(id ?? '').trim().toLowerCase();
  if (!ID_RE.test(next)) {
    throw new ModelsJsonError('供应商 id 只能是小写字母开头、字母数字和连字符,最长 41 位');
  }
  return next;
}

export function assertHttpUrl(raw: string): string {
  const text = String(raw ?? '').trim();
  let url: URL;
  try { url = new URL(text); } catch { throw new ModelsJsonError('接口地址不是合法 URL'); }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new ModelsJsonError('接口地址只接受 http 或 https');
  }
  if (url.hostname === '' || url.hostname === '0.0.0.0') {
    throw new ModelsJsonError('接口地址缺少主机名');
  }
  return url.toString().replace(/\/+$/, '');
}

export function assertApi(raw: unknown): CustomApi {
  const api = String(raw ?? 'openai-completions').trim();
  if ((CUSTOM_APIS as readonly string[]).includes(api)) return api as CustomApi;
  throw new ModelsJsonError(`协议只支持 ${CUSTOM_APIS.join(' / ')}`);
}

export function readModelsJson(filePath = PI_MODELS_PATH): ModelsJsonFile {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as Partial<ModelsJsonFile>;
    const providers = parsed.providers && typeof parsed.providers === 'object' ? parsed.providers : {};
    return { providers: { ...providers } };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { providers: {} };
    throw new ModelsJsonError('models.json 读不出来,文件可能坏了');
  }
}

export function writeModelsJson(file: ModelsJsonFile, filePath = PI_MODELS_PATH): void {
  ensureDirs();
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify({ providers: file.providers }, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, filePath);
}

function defaultModel(id: string, name?: string): ModelsJsonModel {
  return {
    id,
    name: name || id,
    reasoning: true,
    input: ['text', 'image'],
    contextWindow: 128_000,
    maxTokens: 16_384,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
}

export type UpsertCustomProviderInput = {
  id: string;
  name?: string;
  baseUrl: string;
  api?: string;
  models?: Array<{ id: string; name?: string }>;
};

export function upsertCustomProvider(input: UpsertCustomProviderInput, filePath = PI_MODELS_PATH): ModelsJsonProvider {
  const id = assertProviderId(input.id);
  const baseUrl = assertHttpUrl(input.baseUrl);
  const api = assertApi(input.api);
  const file = readModelsJson(filePath);
  const existing = file.providers[id] ?? {};
  const incoming = Array.isArray(input.models) ? input.models : [];
  const models = (incoming.length > 0 ? incoming : (existing.models ?? [{ id: 'default', name: 'default' }])).map((m) => {
    const modelId = String(m.id ?? '').trim();
    if (!modelId) throw new ModelsJsonError('模型 id 不能空');
    return defaultModel(modelId, m.name);
  });
  const next: ModelsJsonProvider = {
    name: String(input.name ?? existing.name ?? id).trim() || id,
    baseUrl,
    api,
    models,
  };
  file.providers[id] = next;
  writeModelsJson(file, filePath);
  return next;
}

export function upsertCustomModel(providerId: string, model: { id: string; name?: string }, filePath = PI_MODELS_PATH): ModelsJsonProvider {
  const id = assertProviderId(providerId);
  const file = readModelsJson(filePath);
  const existing = file.providers[id];
  if (!existing) throw new ModelsJsonError('没有这个自定义供应商');
  const modelId = String(model.id ?? '').trim();
  if (!modelId) throw new ModelsJsonError('模型 id 不能空');
  const models = [...(existing.models ?? [])];
  const index = models.findIndex((m) => m.id === modelId);
  const nextModel = defaultModel(modelId, model.name);
  if (index >= 0) models[index] = { ...models[index], ...nextModel };
  else models.push(nextModel);
  existing.models = models;
  file.providers[id] = existing;
  writeModelsJson(file, filePath);
  return existing;
}

export function removeCustomProvider(providerId: string, filePath = PI_MODELS_PATH): boolean {
  const id = assertProviderId(providerId);
  const file = readModelsJson(filePath);
  if (!file.providers[id]) return false;
  delete file.providers[id];
  writeModelsJson(file, filePath);
  return true;
}

export function listCustomProviderIds(filePath = PI_MODELS_PATH): string[] {
  return Object.keys(readModelsJson(filePath).providers);
}
