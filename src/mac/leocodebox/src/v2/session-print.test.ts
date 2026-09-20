import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { canPrintTalk, clipPrintText, printTalkToast, PRINT_TEXT_MAX } from './session-print';

test('本机才打印这次对话，空的和远端不要', () => {
  const rows = [
    { k: 'user' as const, key: '1', text: '只写一个文件 ART31.txt', mode: 'prompt' as const },
    { k: 'ai' as const, key: '2', text: '先写 ART31.txt，别改别的。', streaming: false },
  ];
  assert.equal(canPrintTalk('local', rows), true);
  assert.equal(canPrintTalk('fold', rows), false);
  assert.equal(canPrintTalk('local', []), false);
  assert.equal(clipPrintText('abc\0def').includes('\0'), false);
  assert.ok(clipPrintText('x'.repeat(PRINT_TEXT_MAX + 20)).includes('后面还有'));
  assert.match(printTalkToast(), /已打开打印/);
});

test('2.0 壳接上了打印这次对话，不进输入栏', () => {
  const app = readFileSync(fileURLToPath(new URL('./App2.tsx', import.meta.url)), 'utf8');
  const main = readFileSync(fileURLToPath(new URL('../../electron/main.js', import.meta.url)), 'utf8');
  assert.match(app, /canPrintTalk/);
  assert.match(app, /打印这次对话/);
  assert.match(main, /leocodebox-desktop:print-text/);
  assert.match(main, /webContents\.print/);
  const acts = app.match(/className="composer-acts"[\s\S]{0,800}/)?.[0] ?? '';
  assert.doesNotMatch(acts, /打印这次对话/);
});
