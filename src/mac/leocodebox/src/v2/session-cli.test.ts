import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { canInstallCli, installCliLabel, installCliToast } from './session-cli';

test('只有装机壳能把命令装进终端', () => {
  assert.equal(canInstallCli(null), false);
  assert.equal(canInstallCli({}), false);
  assert.equal(canInstallCli({ setCliInstall: async () => ({ on: true }) }), true);
  assert.equal(installCliLabel(false), '装进终端');
  assert.equal(installCliLabel(true), '不要装在终端');
  assert.match(installCliToast(true), /已装进终端/);
  assert.match(installCliToast(false), /已从终端拿掉/);
});

test('2.0 壳接上了装进终端，不进输入栏', () => {
  const app = readFileSync(fileURLToPath(new URL('./App2.tsx', import.meta.url)), 'utf8');
  const pages = readFileSync(fileURLToPath(new URL('./pages.tsx', import.meta.url)), 'utf8');
  const main = readFileSync(fileURLToPath(new URL('../../electron/main.js', import.meta.url)), 'utf8');
  assert.match(app, /canInstallCli/);
  assert.match(app, /installCliLabel|装进终端/);
  assert.match(pages, /onInstallCli|装进终端/);
  assert.match(main, /leocodebox-desktop:cli-install/);
  assert.match(main, /cwdFromArgv|enqueueOpenCwd/);
  const acts = app.match(/className="composer-acts"[\s\S]{0,800}/)?.[0] ?? '';
  assert.doesNotMatch(acts, /装进终端|已装进终端/);
});
