import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { canOpenLeoScheme, leoSchemeToast, parseLeoScheme, pickSchemeSession } from './session-scheme';

test('能从 leocodebox:// 拿出目录，系统路径不要', () => {
  assert.equal(parseLeoScheme('https://example.com'), null);
  assert.deepEqual(parseLeoScheme('leocodebox://open?cwd=/tmp/proj'), { cwd: '/tmp/proj' });
  assert.deepEqual(parseLeoScheme('leocodebox:///tmp/proj'), { cwd: '/tmp/proj' });
  assert.equal(canOpenLeoScheme(null), false);
  assert.equal(canOpenLeoScheme({ onLeoScheme: () => () => undefined }), true);
  const hit = pickSchemeSession([
    { machine: 'local', s: { session_id: 'old', cwd: '/tmp/proj', title: '旧', updated_at: 1 } },
    { machine: 'local', s: { session_id: 'new', cwd: '/tmp/proj/', title: '新', updated_at: 9 } },
    { machine: 'fold', s: { session_id: 'r', cwd: '/tmp/proj', title: '远', updated_at: 99 } },
  ], '/tmp/proj');
  assert.equal(hit?.session_id, 'new');
  assert.equal(leoSchemeToast('修登录'), '已打开「修登录」');
  assert.equal(leoSchemeToast(''), '已打开这个目录');
});

test('2.0 壳接上了 leocodebox://，不进输入栏', () => {
  const app = readFileSync(fileURLToPath(new URL('./App2.tsx', import.meta.url)), 'utf8');
  const main = readFileSync(fileURLToPath(new URL('../../electron/main.js', import.meta.url)), 'utf8');
  assert.match(app, /onLeoScheme/);
  assert.match(app, /pickSchemeSession|leoSchemeToast/);
  assert.match(main, /setAsDefaultProtocolClient/);
  assert.match(main, /leocodebox-desktop:open-scheme/);
  const acts = app.match(/className="composer-acts"[\s\S]{0,800}/)?.[0] ?? '';
  assert.doesNotMatch(acts, /leocodebox:\/\/|已打开这个目录|打开这个目录/);
});
