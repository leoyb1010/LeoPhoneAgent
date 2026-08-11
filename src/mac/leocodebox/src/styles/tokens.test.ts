import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const styleFiles = ['../index.css', './tokens.css', './base.css', './chat.css', './settings.css', './file-tree.css'];
const appCss = styleFiles
  .map((relativePath) => readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), 'utf8'))
  .join('\n');
const switchHtml = readFileSync(
  fileURLToPath(new URL('../../public/leocodebox-switch.html', import.meta.url)),
  'utf8',
);

const SHARED_MOTION_TOKENS: Array<[string, string]> = [
  ['--motion-fast', '120ms'],
  ['--motion-base', '200ms'],
  ['--motion-slow', '320ms'],
  ['--ease-out-quint', 'cubic-bezier(0.23, 1, 0.32, 1)'],
  ['--ease-in-out', 'cubic-bezier(0.65, 0, 0.35, 1)'],
];

test('split app styles define the ease + elevation tokens', () => {
  for (const token of ['--ease-out-quint', '--ease-in-out', '--elevation-1', '--elevation-2', '--elevation-3']) {
    assert.ok(appCss.includes(token), `app styles missing ${token}`);
  }
  assert.ok(/\.skeleton\s*\{/.test(appCss), 'app styles missing .skeleton base class');
  assert.ok(appCss.includes('@keyframes skeleton-sweep'), 'app styles missing skeleton-sweep keyframe');
});

test('index.css imports the five design-system style modules', () => {
  const entryCss = readFileSync(fileURLToPath(new URL('../index.css', import.meta.url)), 'utf8');
  for (const file of ['tokens.css', 'base.css', 'chat.css', 'settings.css', 'file-tree.css']) {
    assert.ok(entryCss.includes(file), `index.css missing ${file} import`);
  }
});

test('switch.html carries the same motion/ease token values as app styles', () => {
  for (const [token, value] of SHARED_MOTION_TOKENS) {
    const declaration = `${token}: ${value};`;
    assert.ok(appCss.includes(declaration), `app styles missing "${declaration}"`);
    assert.ok(switchHtml.includes(declaration), `switch.html missing "${declaration}"`);
  }
});
