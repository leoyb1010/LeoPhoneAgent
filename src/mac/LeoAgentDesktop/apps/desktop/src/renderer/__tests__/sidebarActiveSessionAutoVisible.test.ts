/**
 * sidebarActiveSessionAutoVisible — 源码模式断言
 *
 * 锁住"active session 自动可见"链路上几个关键的 hand-wired 行为。这些都是
 * React 组件 / 浏览器 API 副作用,缺乏纯函数表面,所以走静态扫描风格,与
 * sidebarUpperSingleButton.test.ts / sidebarAttentionBadge.test.ts 一致 ——
 * 不依赖 jsdom / RTL,仅锁住"删了 / 改错顺序了不知道"类的回归。
 *
 * 覆盖点:
 *   1. SessionItem 在 isActive 切到 true 时 scrollIntoNearestView,且元素
 *      暴露 data-session-id 给外部 imperative scroll 用
 *   2. scrollIntoNearestView helper 用 block:'nearest' + 防御式
 *      prefers-reduced-motion 检测,reduce 时降级为 instant
 *
 * 注:ProjectNode 旧的「项目级搜索点击先 ensure 展开」覆盖点已随 main 移除项目级
 * 搜索(改为复用全局对话搜索入口)而删除,对应断言一并下线。
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const sessionItemSource = readFileSync(
  resolve(__dirname, '..', 'features', 'cc-agent', 'sidebar', 'SessionItem.tsx'),
  'utf8',
);

const scrollHelperSource = readFileSync(
  resolve(__dirname, '..', 'features', 'cc-agent', 'lib', 'scrollIntoNearestView.ts'),
  'utf8',
);

describe('SessionItem — active 行自动滚进 viewport', () => {
  it('useEffect 依赖只含 isActive(避免无关 re-render 反复滚动)', () => {
    expect(sessionItemSource).toMatch(/scrollIntoNearestView\(rowRef\.current\)[\s\S]*?\}, \[isActive\]\)/);
  });

  it('外层 div 暴露 data-session-id 供外部 imperative scroll 选中', () => {
    expect(sessionItemSource).toMatch(/data-session-id=\{session\.id\}/);
  });
});

describe('scrollIntoNearestView — 共用 helper', () => {
  it('调用 scrollIntoView 且 block: "nearest"(已可见时无副作用)', () => {
    expect(scrollHelperSource).toMatch(/scrollIntoView\(\{[\s\S]*?block:\s*['"]nearest['"]/);
  });

  it('a11y 防御:matchMedia 检测 prefers-reduced-motion: reduce', () => {
    expect(scrollHelperSource).toMatch(/matchMedia/);
    expect(scrollHelperSource).toMatch(/prefers-reduced-motion:\s*reduce/);
  });

  it('reduceMotion 时降级为 instant,否则 smooth(防止有人写死)', () => {
    expect(scrollHelperSource).toMatch(/behavior:\s*\w+\s*\?\s*['"]auto['"]\s*:\s*['"]smooth['"]/);
  });
});
