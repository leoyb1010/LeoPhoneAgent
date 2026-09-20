import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { attachSessionCites, citePathsInPrompt, resolveSessionCitePath, sessionCiteText } from './session-cite.js';

test('提到的文件会一起送进去', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'leocodebox-cite-'));
  const file = path.join(root, 'src');
  fs.mkdirSync(file);
  const target = path.join(file, 'a.ts');
  fs.writeFileSync(target, 'export const ok = 1;\n');
  assert.equal(citePathsInPrompt('改 src/a.ts')[0], 'src/a.ts');
  assert.equal(resolveSessionCitePath('src/a.ts', root), target);
  assert.equal(resolveSessionCitePath('../secret.ts', root), null);
  const body = sessionCiteText('改 src/a.ts', root);
  assert.match(body, /```src\/a\.ts/);
  assert.match(body, /export const ok = 1;/);
  const frame = attachSessionCites({ type: 'prompt', message: '改 src/a.ts' }, '改 src/a.ts', root);
  assert.match(String(frame.message), /改 src\/a\.ts/);
  assert.match(String(frame.message), /export const ok = 1;/);
  fs.rmSync(root, { recursive: true, force: true });
});
