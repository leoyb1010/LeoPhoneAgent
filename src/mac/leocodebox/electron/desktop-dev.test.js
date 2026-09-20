import assert from 'node:assert/strict';
import { lstatSync, readFileSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { ensureDevBackendHelper } from '../scripts/ensure-dev-backend-helper.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('开发后端走 LSUIElement helper,不再单独把 Electron.app 挂进 Dock', () => {
  const script = readFileSync(path.join(root, 'scripts/desktop-dev.mjs'), 'utf8');
  const plist = readFileSync(path.join(root, 'scripts/dev-backend.app/Contents/Info.plist'), 'utf8');
  const helper = ensureDevBackendHelper(root);
  const frameworks = path.join(root, 'scripts/dev-backend.app/Contents/Frameworks');
  const electronBin = path.join(root, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron');
  assert.match(script, /ensureDevBackendHelper/);
  assert.match(script, /ELECTRON_RUN_AS_NODE: '1'/);
  assert.match(script, /tsxLoader/);
  assert.match(script, /tsxPreflight/);
  assert.doesNotMatch(script, /tsxCli/);
  assert.match(plist, /LSUIElement/);
  assert.match(plist, /LSBackgroundOnly/);
  assert.equal(lstatSync(helper).isSymbolicLink(), false);
  assert.ok(lstatSync(frameworks).isSymbolicLink());
  assert.equal(statSync(helper).ino, statSync(electronBin).ino);
  assert.match(realpathSync(frameworks), /Electron\.app\/Contents\/Frameworks$/);
});
