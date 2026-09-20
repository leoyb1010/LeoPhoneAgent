import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { canClearCache, clearCacheLabel, clearCacheToast } from './session-cache';

test('只有装机壳能清掉缓存', () => {
  assert.equal(canClearCache(null), false);
  assert.equal(canClearCache({}), false);
  assert.equal(canClearCache({ clearCache: async () => ({ ok: true }) }), true);
  assert.equal(clearCacheLabel(), '清掉缓存');
  assert.match(clearCacheToast(), /已清掉缓存/);
});

test('2.0 壳接上了清缓存，不进输入栏', () => {
  const app = readFileSync(fileURLToPath(new URL('./App2.tsx', import.meta.url)), 'utf8');
  const pages = readFileSync(fileURLToPath(new URL('./pages.tsx', import.meta.url)), 'utf8');
  const main = readFileSync(fileURLToPath(new URL('../../electron/main.js', import.meta.url)), 'utf8');
  assert.match(app, /canClearCache/);
  assert.match(app, /clearCacheLabel|清掉缓存/);
  assert.match(pages, /onClearCache|清掉缓存/);
  assert.match(main, /leocodebox-desktop:clear-cache/);
  assert.match(main, /clearLocalOnlyWebCaches|clearCache/);
  const acts = app.match(/className="composer-acts"[\s\S]{0,800}/)?.[0] ?? '';
  assert.doesNotMatch(acts, /清掉缓存|已清掉缓存/);
});
