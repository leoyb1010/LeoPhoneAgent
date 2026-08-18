import test from 'node:test';
import assert from 'node:assert/strict';

import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';

import ChipMenu from './ChipMenu';

// 展开时 ChipMenu 会往 document 上挂"点外面就关"的监听;node 里没有 DOM,给个空壳。
const globals = globalThis as unknown as { document?: unknown };
globals.document ??= { addEventListener: () => undefined, removeEventListener: () => undefined };

/**
 * 用户怀疑指挥条里 "Claude Code ▼" 的下拉箭头点不到。
 * 结论是没被遮挡:箭头是触发按钮自己的子节点,整片芯片(徽标 + 文字 + 箭头)
 * 都在同一个 onClick 上;唯一的绝对定位元素是展开后的菜单,而它在按钮**下方**
 * (top-11 = 44px,大于按钮 36px 的高度),关着的时候根本不渲染。
 * 这几条断言把这个结构钉住,免得以后有人把箭头挪出按钮或往上面盖东西。
 */
function render() {
  let renderer!: TestRenderer.ReactTestRenderer;
  act(() => {
    renderer = TestRenderer.create(
      <ChipMenu
        value="claude"
        options={[
          { value: 'claude', label: 'Claude Code' },
          { value: 'codex', label: 'Codex' },
        ]}
        onSelect={() => undefined}
        tooltip="选择 Agent"
        ariaLabel="选择 Agent"
        className="wb-agent-button h-9 gap-[7px] rounded-[10px] px-2.5"
      >
        <span>Claude Code</span>
      </ChipMenu>,
    );
  });
  return renderer;
}

const trigger = (renderer: TestRenderer.ReactTestRenderer) =>
  renderer.root.findAllByType('button').find((node) => node.props['aria-haspopup'] === 'menu')!;

function texts(node: TestRenderer.ReactTestInstance): string[] {
  return node.children.flatMap((child) => (typeof child === 'string' ? [child] : texts(child)));
}

test('下拉箭头就长在触发按钮里 —— 点箭头等于点整片芯片', () => {
  const renderer = render();
  const button = trigger(renderer);
  assert.ok(texts(button).includes('▼'), '箭头必须是按钮的子节点');
  assert.equal(typeof button.props.onClick, 'function');
});

test('关着的时候没有任何绝对定位元素浮在芯片上', () => {
  const renderer = render();
  const absolutes = renderer.root.findAll(
    (node) => typeof node.type === 'string' && String(node.props.className ?? '').includes('absolute'),
    { deep: true },
  );
  assert.deepEqual(absolutes, []);
});

test('展开后箭头翻向上,菜单落在按钮下方而不是压住它', () => {
  const renderer = render();
  act(() => { trigger(renderer).props.onClick(); });

  assert.ok(texts(trigger(renderer)).includes('▲'));
  const menu = renderer.root.findAll((node) => node.props?.role === 'menu')[0];
  // top-11(44px)> 按钮高度 h-9(36px),所以菜单不会盖在点击区上。
  assert.ok(String(menu.props.className).includes('top-11'));
  assert.ok(String(menu.props.className).includes('absolute'));
});
