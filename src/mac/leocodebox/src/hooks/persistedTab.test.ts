import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { isValidTab } from './projectStateUtils';

/**
 * [T-tab-persistence] 页签栏里画得出来的页签,持久化白名单里就必须认得。
 *
 * 之前 `audit`(会话审计)不在白名单、`fleet`(Mac 控制台)还被列成已下线,
 * 而两者在 MainContentTabSwitcher 里是无条件渲染的:点得开、面板真在、接口也在,
 * 唯独重启之后 readPersistedTab 判它们非法,把人默默弹回聊天。这个测试把
 * "页签栏"和"白名单"这两份清单钉在一起,免得再各自漂移。
 */
const switcher = readFileSync(
  path.resolve('src/components/main-content/view/subcomponents/MainContentTabSwitcher.tsx'),
  'utf8',
);

/** 从 TabSwitcher 里抓出所有内置页签的 id(含条件显示的)。 */
function declaredBuiltInTabs(): string[] {
  return [...switcher.matchAll(/kind:\s*'builtin',\s*\n?\s*id:\s*'([a-zA-Z]+)'/g)].map((m) => m[1]);
}

test('TabSwitcher 里的每一个内置页签都能被持久化白名单接受', () => {
  const tabs = declaredBuiltInTabs();
  assert.ok(tabs.length >= 6, `没抓到页签清单(只抓到 ${tabs.length} 个),正则可能过时了`);
  for (const tab of tabs) {
    assert.ok(isValidTab(tab), `页签 ${tab} 在页签栏里渲染,却过不了持久化校验`);
  }
});

test('会话审计与 Mac 控制台是真页签,不能再当作已下线', () => {
  const tabs = declaredBuiltInTabs();
  assert.ok(tabs.includes('audit') && tabs.includes('fleet'));
  assert.ok(isValidTab('audit'));
  assert.ok(isValidTab('fleet'));
});

test('插件页签照旧放行', () => {
  assert.ok(isValidTab('plugin:project-stats'));
  assert.ok(isValidTab('plugin:web-terminal'));
});

test('真下线的页签仍然不合法', () => {
  // 只剩 missions:快速任务搬进了 ⌘K,页签栏里已经没有它。
  assert.equal(isValidTab('missions'), false);
});

test('主控台不在页签栏里,但必须能被持久化 —— 它是这个外壳的落地页', () => {
  // dashboard 不由 TabSwitcher 渲染(MainContent 在它那个分支直接接管整块主区),
  // 所以上面那条"页签栏 ↔ 白名单"的对照抓不到它。这里单独钉住:它是「选 Agent
  // 开新任务」唯一不产生歧义的落点,重启后被判非法弹回聊天就等于把入口弄丢了。
  assert.ok(!declaredBuiltInTabs().includes('dashboard'), '主控台不该出现在项目页签栏里');
  assert.equal(isValidTab('dashboard'), true);
});
