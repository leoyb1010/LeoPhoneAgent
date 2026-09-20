import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { customDraftReady, emptyCustomDraft, filterCatalog, filterProviders, providersShownBeforeMore, rankProvidersForLogin, summarizeModels, summarizeProviderModels, usableModelsFromProviders } from './settings-form';

test('兼容接口草稿必须有 id、地址和至少一个模型', () => {
  const empty = emptyCustomDraft();
  assert.equal(customDraftReady(empty), false);
  assert.equal(customDraftReady({ ...empty, id: 'home', baseUrl: 'http://127.0.0.1:11434/v1' }), false);
  assert.equal(customDraftReady({ ...empty, id: 'home', baseUrl: 'http://127.0.0.1:11434/v1', modelId: 'grok-4.6' }), true);
  assert.equal(customDraftReady({ ...empty, id: 'Home', baseUrl: 'http://127.0.0.1:11434/v1', modelId: 'x' }), true);
  assert.equal(customDraftReady({ ...empty, id: '1home', baseUrl: 'http://127.0.0.1:11434/v1', modelId: 'x' }), false);
  assert.equal(customDraftReady({ ...empty, id: 'home', baseUrl: 'javascript:alert(1)', modelId: 'x' }), false);
});

test('模型摘要一行说清数量,不堆卡片', () => {
  assert.equal(summarizeModels([]), '—');
  assert.equal(summarizeModels([{ name: 'A' }, { name: 'B' }]), 'A · B');
  assert.equal(summarizeModels([{ name: 'A' }, { name: 'B' }, { name: 'C' }, { name: 'D' }]), 'A · B · C +1');
  assert.deepEqual(filterCatalog([{ id: 'grok-4.6', name: 'Grok 4.6' }, { id: 'glm-5.3', name: 'GLM-5.3' }], 'grok').map((m) => m.id), ['grok-4.6']);
});

test('选择器只列出已登录供应商的运行时模型,不把预设旗舰 id 当成可用', () => {
  const usable = usableModelsFromProviders([
    {
      id: 'anthropic', name: 'Anthropic', configured: true,
      models: [{ id: 'live-from-provider', name: 'Live From Provider' }],
    },
    {
      id: 'openai', name: 'OpenAI', configured: false,
      models: [{ id: 'gpt-5.6', name: 'GPT-5.6' }, { id: 'claude-opus-5', name: 'Claude Opus 5' }],
    },
    {
      id: 'xai', name: 'xAI', configured: false,
      models: [{ id: 'grok-4.6', name: 'Grok 4.6' }],
    },
  ]);
  assert.deepEqual(usable.map((m) => `${m.provider}/${m.id}`), ['anthropic/live-from-provider']);
  assert.equal(usable.some((m) => m.id === 'gpt-5.6' || m.id === 'claude-opus-5' || m.id === 'grok-4.6'), false);
});

test('OAuth 未登录的摘要不假装已经有模型', () => {
  assert.equal(summarizeProviderModels({ oauth: true, configured: false, models: [] }), '登录后从提供方读取');
  assert.equal(summarizeProviderModels({ oauth: true, configured: true, models: [] }), '提供方未返回模型');
  assert.equal(summarizeProviderModels({ oauth: true, configured: true, models: [{ name: 'Live' }] }), 'Live');
  assert.equal(summarizeProviderModels({ oauth: false, configured: false, models: [{ name: 'Gemini 3' }, { name: 'Preset' }] }), '填密钥后从提供方读取');
});

test('没登录时设置页先排常用供应商,也能按名字找', () => {
  const ranked = rankProvidersForLogin([
    { id: 'together', name: 'Together', configured: false },
    { id: 'anthropic', name: 'Anthropic', configured: false },
    { id: 'foo', name: 'Foo', configured: true },
    { id: 'openai', name: 'OpenAI', configured: false },
  ]);
  assert.deepEqual(ranked.map((p) => p.id), ['foo', 'anthropic', 'openai', 'together']);
  assert.deepEqual(filterProviders(ranked, 'open').map((p) => p.id), ['openai']);
  const pages = readFileSync(fileURLToPath(new URL('./pages.tsx', import.meta.url)), 'utf8');
  assert.match(pages, /rankProvidersForLogin/);
  assert.match(pages, /rankModelsForPicker\(usableModelsFromProviders/);
  assert.match(pages, /找供应商/);
  assert.match(pages, /不是写死的名单|不展示预设名单/);
});

test('设置首页只留已登录和常用入口,其余靠找或更多', () => {
  const ranked = rankProvidersForLogin([
    { id: 'together', name: 'Together', configured: false },
    { id: 'openai-codex', name: 'OpenAI Codex', configured: true },
    { id: 'amazon-bedrock', name: 'Amazon Bedrock', configured: false },
    { id: 'anthropic', name: 'Anthropic', configured: false },
  ]);
  assert.equal(ranked[0]?.id, 'openai-codex');
  const home = providersShownBeforeMore(ranked, '', false);
  assert.deepEqual(home.shown.map((p) => p.id), ['openai-codex', 'anthropic']);
  assert.equal(home.hidden, 2);
  assert.equal(providersShownBeforeMore(ranked, 'bed', false).shown.map((p) => p.id).join(), 'amazon-bedrock');
  assert.equal(providersShownBeforeMore(ranked, '', true).hidden, 0);
  const pages = readFileSync(fileURLToPath(new URL('./pages.tsx', import.meta.url)), 'utf8');
  assert.match(pages, /providersShownBeforeMore/);
  assert.match(pages, /更多供应商/);
});
