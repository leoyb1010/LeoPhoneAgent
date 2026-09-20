import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { markWhatsNewSeenFor, releaseNoteForVersion, shouldShowWhatsNewFor, WHATS_NEW_SEEN_KEY } from './whats-new';

const packageVersion = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../package.json', import.meta.url)), 'utf8'),
).version as string;

test('当前版本的本次更新就是清单第一条,不是上一版', () => {
  const notes = [
    { version: packageVersion, date: '2026-09-20', items: ['这一版改了弹窗'] },
    { version: '0.0.1', date: '2026-01-01', items: ['上一版的内容'] },
  ];
  const note = releaseNoteForVersion(notes, packageVersion);
  assert.deepEqual(note, notes[0]);
  assert.notEqual(note?.items[0], '上一版的内容');
});

test('漏写条目时明说缺失,绝不拿上一版条目顶上', () => {
  const notes = [{ version: '2.0.11', date: '2026-09-20', items: ['OAuth 目录'] }];
  const note = releaseNoteForVersion(notes, '9.9.9');
  assert.equal(note?.version, '9.9.9');
  assert.match(note?.items[0] ?? '', /更新说明缺失/);
  assert.notEqual(note?.items[0], 'OAuth 目录');
});

test('没注入版本号就不弹,版本变了才弹,看完才记账', () => {
  const store = new Map<string, string>();
  assert.equal(shouldShowWhatsNewFor('', (key) => store.get(key) ?? null), false);
  assert.equal(shouldShowWhatsNewFor('2.0.12', (key) => store.get(key) ?? null), true);
  markWhatsNewSeenFor('2.0.12', (key, value) => { store.set(key, value); });
  assert.equal(store.get(WHATS_NEW_SEEN_KEY), '2.0.12');
  assert.equal(shouldShowWhatsNewFor('2.0.12', (key) => store.get(key) ?? null), false);
  assert.equal(shouldShowWhatsNewFor('2.0.13', (key) => store.get(key) ?? null), true);
});

test('vite 把 package.json 版本注入前端,2.0 壳会画本次更新', () => {
  const vite = readFileSync(fileURLToPath(new URL('../../vite.config.js', import.meta.url)), 'utf8');
  const app = readFileSync(fileURLToPath(new URL('./App2.tsx', import.meta.url)), 'utf8');
  const overlay = readFileSync(fileURLToPath(new URL('./WhatsNewOverlay.tsx', import.meta.url)), 'utf8');
  assert.match(vite, /VITE_APP_VERSION/);
  assert.match(vite, /package\.json/);
  assert.match(app, /WhatsNewOverlay/);
  assert.match(app, /shouldShowWhatsNew/);
  assert.match(app, /currentAppVersion/);
  assert.match(app, /\[appVersion\]/);
  assert.match(overlay, /知道了/);
  assert.match(overlay, /本次更新/);
  assert.doesNotMatch(overlay, /onClick=\{close\}/);
});
