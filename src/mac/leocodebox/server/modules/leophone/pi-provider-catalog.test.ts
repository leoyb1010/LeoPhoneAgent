import assert from 'node:assert/strict';
import { test } from 'node:test';

import { MODEL_ARSENAL } from '@/shared/model-arsenal.js';

import {
  catalogFromRuntimeModels,
  describeProvider,
  loadRuntimeModelsForProvider,
  refreshOAuthCatalogs,
  sketchProviderAuth,
  type CatalogRuntime,
  type DescribeRuntime,
  type RuntimeModel,
} from './pi-provider-catalog.js';

const PRESET_IDS = ['claude-opus-5', 'gpt-5.6', 'gpt-5.6-sol', 'grok-4.6'];

function bakedModels(provider: string): RuntimeModel[] {
  return PRESET_IDS.map((id) => ({ id, provider, name: id }));
}

function fakeDescribeRuntime(overrides: Partial<DescribeRuntime> & Pick<CatalogRuntime, 'getModels' | 'getAvailable' | 'refresh'>): DescribeRuntime {
  return {
    getProviderAuthStatus: () => ({ configured: false }),
    hasConfiguredAuth: () => false,
    isUsingOAuth: () => false,
    isUsingSubscription: () => false,
    getRegisteredProviderConfig: () => undefined,
    ...overrides,
  };
}

test('OAuth 已登录:目录等于运行时 getAvailable 的返回,不补成本表 / 预设 id', async () => {
  const live: RuntimeModel[] = [
    { id: 'live-from-provider', provider: 'anthropic', name: 'Live From Provider', reasoning: true, contextWindow: 200_000 },
  ];
  let refreshed: { allowNetwork?: boolean; providers?: readonly string[]; force?: boolean } | undefined;
  const runtime = fakeDescribeRuntime({
    isUsingOAuth: () => true,
    hasConfiguredAuth: () => true,
    getProviderAuthStatus: () => ({ configured: true }),
    getModels: () => bakedModels('anthropic'),
    getAvailable: async () => live,
    refresh: async (options) => { refreshed = options; },
  });

  const listed = await loadRuntimeModelsForProvider(runtime, {
    id: 'anthropic', oauth: true, custom: false, configured: true,
  });
  const catalog = catalogFromRuntimeModels({ id: 'anthropic', oauth: true, custom: false, configured: true }, listed);

  assert.deepEqual(catalog.map((m) => m.id), ['live-from-provider']);
  assert.equal(catalog[0]?.name, 'Live From Provider');
  assert.ok(!MODEL_ARSENAL.some((row) => row.id === 'live-from-provider'), '夹具 id 不在 MODEL_ARSENAL 里,证明目录不是成本表');
  for (const preset of PRESET_IDS) {
    assert.equal(catalog.some((m) => m.id === preset), false, `不应注入预设 ${preset}`);
  }
  assert.equal(refreshed?.allowNetwork, true);
  assert.deepEqual(refreshed?.providers, ['anthropic']);
  assert.equal(refreshed?.force, true);
});

test('OAuth 未登录:即使 getModels 全是旗舰预设,可选目录也是空的', () => {
  const catalog = catalogFromRuntimeModels(
    { id: 'openai', oauth: true, custom: false, configured: false },
    bakedModels('openai'),
  );
  assert.deepEqual(catalog, []);
});

test('密钥供应商未配置:不把 getModels 的内置名单当成可用目录', () => {
  const catalog = catalogFromRuntimeModels(
    { id: 'google', oauth: false, custom: false, configured: false },
    bakedModels('google'),
  );
  assert.deepEqual(catalog, []);
});

test('密钥供应商未配置的 load 不读运行时内置名单', async () => {
  let refreshed = false;
  const runtime: CatalogRuntime = {
    getModels: () => bakedModels('google'),
    getAvailable: async () => bakedModels('google'),
    refresh: async () => { refreshed = true; },
  };
  const listed = await loadRuntimeModelsForProvider(runtime, {
    id: 'google', oauth: false, custom: false, configured: false,
  });
  assert.deepEqual(listed, []);
  assert.equal(refreshed, false);
});

test('OAuth 未登录的 load 不去刷新、也不读运行时目录', async () => {
  let refreshed = false;
  const runtime: CatalogRuntime = {
    getModels: () => bakedModels('xai'),
    getAvailable: async () => bakedModels('xai'),
    refresh: async () => { refreshed = true; },
  };
  const listed = await loadRuntimeModelsForProvider(runtime, {
    id: 'xai', oauth: true, custom: false, configured: false,
  });
  assert.deepEqual(listed, []);
  assert.equal(refreshed, false);
});

test('自定义兼容接口按用户手录的 getModels id 列出,不走 OAuth 刷新', async () => {
  let refreshed = false;
  const entered: RuntimeModel[] = [{ id: 'qwen3-coder', provider: 'home-ollama', name: 'Qwen3 Coder' }];
  const runtime: CatalogRuntime = {
    getModels: (id) => (id === 'home-ollama' ? entered : []),
    getAvailable: async () => bakedModels('anthropic'),
    refresh: async () => { refreshed = true; },
  };
  const listed = await loadRuntimeModelsForProvider(runtime, {
    id: 'home-ollama', oauth: false, custom: true, configured: true,
  });
  assert.deepEqual(listed.map((m) => m.id), ['qwen3-coder']);
  assert.equal(refreshed, false);
});

test('providers 重载时只刷新已登录的 OAuth 供应商', async () => {
  const seen: string[][] = [];
  const runtime: CatalogRuntime = {
    getModels: () => [],
    getAvailable: async () => [],
    refresh: async (options) => { seen.push([...(options?.providers ?? [])]); },
  };
  await refreshOAuthCatalogs(runtime, ['anthropic', 'anthropic', 'openai']);
  assert.deepEqual(seen, [['anthropic', 'openai']]);
  await refreshOAuthCatalogs(runtime, []);
  assert.deepEqual(seen, [['anthropic', 'openai']]);
});

test('auth.json 里的 oauth 在运行时快照还没跟上时也算已登录', () => {
  const runtime = fakeDescribeRuntime({
    getModels: () => [],
    getAvailable: async () => [],
    refresh: async () => undefined,
    isUsingOAuth: () => false,
    hasConfiguredAuth: () => false,
    getProviderAuthStatus: () => ({ configured: false }),
  });
  const auth = sketchProviderAuth(runtime, { id: 'anthropic', name: 'Anthropic', auth: { oauth: {} } }, new Set(), { anthropic: 'oauth' });
  assert.equal(auth.configured, true);
  assert.equal(auth.usingOAuth, true);
  assert.equal(auth.oauth, true);
});

test('describeProvider 把 OAuth 目录收成运行时返回值', async () => {
  const runtime = fakeDescribeRuntime({
    isUsingOAuth: () => true,
    hasConfiguredAuth: () => true,
    getProviderAuthStatus: () => ({ configured: true }),
    getModels: () => bakedModels('google'),
    getAvailable: async () => [{ id: 'gemini-live-only', provider: 'google', name: 'Gemini Live' }],
    refresh: async () => undefined,
  });
  const described = await describeProvider(
    runtime,
    { id: 'google', name: 'Google', auth: { oauth: {} } },
    new Set(),
    { google: 'oauth' },
    { refreshOAuth: false },
  );
  assert.deepEqual(described.models.map((m) => m.id), ['gemini-live-only']);
  assert.equal(described.configured, true);
  assert.equal(described.usingOAuth, true);
});
