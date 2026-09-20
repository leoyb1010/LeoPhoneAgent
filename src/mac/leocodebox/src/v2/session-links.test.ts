import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { canOpenTalkLinks, clipTalkUrl, sessionTalkLinks, talkLinkPickerHint, talkLinkToast } from './session-links';

test('本机才能打开对话里的链接，坏协议不要', () => {
  const rows = [
    { k: 'ai' as const, key: '1', text: '本地看 http://127.0.0.1:5173/ ，文档 https://example.com/docs。', streaming: false },
    { k: 'user' as const, key: '2', text: '还有 localhost:38473/health', mode: 'prompt' as const },
    { k: 'tool' as const, key: '3', toolUseId: null, tool: 'bash', preview: 'javascript:alert(1)', output: 'data:text/html,x', running: false, error: false },
  ];
  const links = sessionTalkLinks(rows);
  assert.deepEqual(links.map((row) => row.url), [
    'http://127.0.0.1:5173/',
    'https://example.com/docs',
    'http://localhost:38473/health',
  ]);
  assert.equal(canOpenTalkLinks('local', links), true);
  assert.equal(canOpenTalkLinks('fold', links), false);
  assert.equal(canOpenTalkLinks('local', []), false);
  assert.equal(clipTalkUrl('javascript:alert(1)'), '');
  assert.equal(talkLinkPickerHint(2), '2 个链接');
  assert.match(talkLinkToast('https://example.com/docs'), /example.com/);
});

test('2.0 壳接上了打开对话里的链接，不进输入栏', () => {
  const app = readFileSync(fileURLToPath(new URL('./App2.tsx', import.meta.url)), 'utf8');
  assert.match(app, /sessionTalkLinks/);
  assert.match(app, /打开对话里的链接/);
  const acts = app.match(/className="composer-acts"[\s\S]{0,800}/)?.[0] ?? '';
  assert.doesNotMatch(acts, /打开对话里的链接/);
});
