import { afterEach, describe, expect, it } from 'vitest';

import {
  __resetPanelRegistryForTest,
  getPanelKind,
  hasPanelKind,
  listPanelKinds,
  registerPanelKind,
  type PanelComponentProps,
} from '../registry';

/** 测试用哑组件 —— registry 只存引用,不渲染,普通函数即可。 */
function makeComponent(name: string) {
  const Component = (_props: PanelComponentProps) => null;
  Component.displayName = name;
  return Component;
}

afterEach(() => {
  __resetPanelRegistryForTest();
});

describe('panel registry', () => {
  it('注册后可查到(含 collapseMemory 声明),未注册返回 null', () => {
    const Component = makeComponent('A');
    registerPanelKind({ kind: 'session-list', Component, collapseMemory: 'global' });
    expect(getPanelKind('session-list')?.Component).toBe(Component);
    expect(getPanelKind('session-list')?.collapseMemory).toBe('global');
    expect(getPanelKind('ghost:not-installed')).toBeNull();
    expect(hasPanelKind('session-list')).toBe(true);
    expect(hasPanelKind('chat-main')).toBe(false);
  });

  it('重复注册同 kind:覆盖而非抛错(HMR 安全)', () => {
    const A = makeComponent('A');
    const B = makeComponent('B');
    registerPanelKind({ kind: 'chat-main', Component: A, collapseMemory: 'none' });
    expect(() =>
      registerPanelKind({ kind: 'chat-main', Component: B, collapseMemory: 'none' }),
    ).not.toThrow();
    expect(getPanelKind('chat-main')?.Component).toBe(B);
    expect(listPanelKinds()).toEqual(['chat-main']);
  });

  it('意识命名空间的 kind 同样可注册(未来 ghost:* 面板走同一入口)', () => {
    registerPanelKind({
      kind: 'ghost:weekly-report',
      Component: makeComponent('W'),
      collapseMemory: 'per-session',
    });
    expect(hasPanelKind('ghost:weekly-report')).toBe(true);
    expect(listPanelKinds()).toContain('ghost:weekly-report');
  });
});
