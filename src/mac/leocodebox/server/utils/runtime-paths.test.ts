import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';

import { detectInstallMode } from './runtime-paths.js';

test('装进 .app 报 bundled,仓库报 git,其余报 npm', () => {
  assert.equal(detectInstallMode('/Users/leo/LeoPhoneAgent/src/mac/leocodebox', (file) => file.endsWith(`${path.sep}.git`)), 'git');
  assert.equal(detectInstallMode('/Applications/leocodebox.app/Contents/Resources/app', () => false), 'bundled');
  assert.equal(detectInstallMode('/usr/local/lib/node_modules/leocodebox', () => false), 'npm');
});
