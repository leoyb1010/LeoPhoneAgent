import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { canHideSecrets, hideSecrets, hideSecretsToast, sessionHasSecrets, textHasSecrets } from './session-hide';

test('对话里的密钥可以藏住，远端和空的不要', () => {
  const key = 'sk-abcdefghijklmnopqrstuvwxyz012345';
  assert.equal(textHasSecrets(`token ${key}`), true);
  assert.equal(hideSecrets(`用 ${key} 调一下`).includes(key), false);
  assert.match(hideSecrets(`用 ${key} 调一下`), /••••/);
  assert.equal(textHasSecrets('只写一个文件 ART31.txt'), false);
  const rows = [
    { k: 'user' as const, key: '1', text: `先用 ${key}`, mode: 'prompt' as const },
    { k: 'ai' as const, key: '2', text: '好。', streaming: false },
  ];
  assert.equal(sessionHasSecrets(rows), true);
  assert.equal(canHideSecrets('local', rows), true);
  assert.equal(canHideSecrets('fold', rows), false);
  assert.equal(canHideSecrets('local', []), false);
  assert.match(hideSecretsToast(true), /已藏住密钥/);
  assert.match(hideSecretsToast(false), /已显示密钥/);
});

test('2.0 壳接上了藏住密钥，不进输入栏', () => {
  const app = readFileSync(fileURLToPath(new URL('./App2.tsx', import.meta.url)), 'utf8');
  const flow = readFileSync(fileURLToPath(new URL('./flow.tsx', import.meta.url)), 'utf8');
  assert.match(app, /canHideSecrets/);
  assert.match(app, /藏住密钥/);
  assert.match(flow, /hideSecrets/);
  const acts = app.match(/className="composer-acts"[\s\S]{0,800}/)?.[0] ?? '';
  assert.doesNotMatch(acts, /藏住密钥/);
});
