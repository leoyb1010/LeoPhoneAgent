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

test('the app shell does not blanket-position its direct children', () => {
  // 这条规则(`.leocodebox-app-shell > * { position: relative }`)会把每个直接
  // 子元素的定位改写掉:Leoapi 面板、本地工具模态这些 fixed/absolute 浮层挂到
  // 外壳下就被打回文档流,表现为"弹层出现在状态栏下面""下拉气泡被主区盖住"。
  // 层级改由子元素各自声明,这里把它钉死,避免以后又被加回来。
  // 注释里写了这条规则长什么样,所以先把注释剥掉再匹配。
  const withoutComments = appCss.replace(/\/\*[\s\S]*?\*\//g, '');
  assert.ok(
    !/\.leocodebox-app-shell\s*>\s*\*\s*(?::not\([^)]*\))?\s*\{/.test(withoutComments),
    'app styles must not blanket-position .leocodebox-app-shell > *',
  );
});

test('switch.html carries the same motion/ease token values as app styles', () => {
  for (const [token, value] of SHARED_MOTION_TOKENS) {
    const declaration = `${token}: ${value};`;
    assert.ok(appCss.includes(declaration), `app styles missing "${declaration}"`);
    assert.ok(switchHtml.includes(declaration), `switch.html missing "${declaration}"`);
  }
});
