import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import {
  ModelsJsonError,
  assertHttpUrl,
  assertProviderId,
  listCustomProviderIds,
  readModelsJson,
  removeCustomProvider,
  upsertCustomModel,
  upsertCustomProvider,
} from './pi-models.js';

function tmpFile(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'leo-models-')), 'models.json');
}

test('供应商 id 与接口地址拒绝危险输入', () => {
  assert.equal(assertProviderId('LeoAPI'), 'leoapi');
  assert.equal(assertProviderId('OpenAI'), 'openai');
  assert.throws(() => assertProviderId('../etc'), ModelsJsonError);
  assert.throws(() => assertProviderId('1start'), ModelsJsonError);
  assert.equal(assertHttpUrl('https://api.example.com/v1/'), 'https://api.example.com/v1');
  assert.throws(() => assertHttpUrl('file:///etc/passwd'), ModelsJsonError);
  assert.throws(() => assertHttpUrl('javascript:alert(1)'), ModelsJsonError);
  assert.throws(() => assertHttpUrl('not a url'), ModelsJsonError);
});

test('录入自定义兼容接口会写成 pi 的 models.json,密钥不进文件', () => {
  const file = tmpFile();
  const provider = upsertCustomProvider({
    id: 'home-ollama',
    name: '家里的 Ollama',
    baseUrl: 'http://127.0.0.1:11434/v1',
    api: 'openai-completions',
    models: [{ id: 'qwen3-coder', name: 'Qwen3 Coder' }],
  }, file);
  assert.equal(provider.name, '家里的 Ollama');
  assert.equal(provider.baseUrl, 'http://127.0.0.1:11434/v1');
  assert.equal(provider.apiKey, undefined);
  assert.equal(provider.models?.[0]?.id, 'qwen3-coder');
  assert.deepEqual(listCustomProviderIds(file), ['home-ollama']);
  const disk = JSON.parse(fs.readFileSync(file, 'utf8')) as { providers: Record<string, { apiKey?: string }> };
  assert.equal(disk.providers['home-ollama']?.apiKey, undefined);
});

test('给已有接口追加模型,删除时整家供应商一起拿掉', () => {
  const file = tmpFile();
  upsertCustomProvider({ id: 'local-gw', baseUrl: 'https://gw.example/v1', models: [{ id: 'a' }] }, file);
  upsertCustomModel('local-gw', { id: 'b', name: 'B' }, file);
  const after = readModelsJson(file).providers['local-gw'];
  assert.deepEqual((after.models ?? []).map((m) => m.id), ['a', 'b']);
  assert.equal(removeCustomProvider('local-gw', file), true);
  assert.deepEqual(listCustomProviderIds(file), []);
  assert.equal(removeCustomProvider('local-gw', file), false);
});

test('缺文件当成空目录,坏 JSON 明确报错', () => {
  const missing = path.join(os.tmpdir(), `leo-models-missing-${process.pid}.json`);
  assert.deepEqual(readModelsJson(missing), { providers: {} });
  const broken = tmpFile();
  fs.writeFileSync(broken, '{not-json');
  assert.throws(() => readModelsJson(broken), ModelsJsonError);
});
