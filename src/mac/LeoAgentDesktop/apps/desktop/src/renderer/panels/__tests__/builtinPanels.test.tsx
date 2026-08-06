// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { BuiltinPanelBridgeProvider, type BuiltinPanelBridge } from '../BuiltinPanelBridge';
import {
  __resetBuiltinPanelsForTest,
  ChatMainPanel,
  registerBuiltinPanels,
  RightTabsPanel,
  SessionListPanel,
} from '../builtinPanels';
import { __resetPanelRegistryForTest, getPanelKind, listPanelKinds } from '../registry';

const bridge: BuiltinPanelBridge = {
  sessionList: <div data-testid="slot-sessions">sessions</div>,
  chatMain: <div data-testid="slot-chat">chat</div>,
  rightTabs: <div data-testid="slot-right">right</div>,
};

afterEach(() => {
  cleanup();
  __resetPanelRegistryForTest();
  __resetBuiltinPanelsForTest();
});

describe('builtin panels · 只包不改的桥接渲染', () => {
  it('三个包装组件各自渲染 bridge 里对应的节点', () => {
    render(
      <BuiltinPanelBridgeProvider value={bridge}>
        <SessionListPanel paneId="sessions" />
        <ChatMainPanel paneId="chat" />
        <RightTabsPanel paneId="right" />
      </BuiltinPanelBridgeProvider>,
    );
    expect(screen.getByTestId('slot-sessions')).toBeTruthy();
    expect(screen.getByTestId('slot-chat')).toBeTruthy();
    expect(screen.getByTestId('slot-right')).toBeTruthy();
  });

  it('Provider 缺失时渲染为空,不抛异常', () => {
    expect(() => {
      const { container } = render(<ChatMainPanel paneId="chat" />);
      expect(container.innerHTML).toBe('');
    }).not.toThrow();
  });

  it('registerBuiltinPanels 幂等注册三个内置 kind', () => {
    registerBuiltinPanels();
    registerBuiltinPanels(); // 幂等:第二次不重复注册也不抛
    expect(listPanelKinds().sort()).toEqual(['chat-main', 'right-tabs', 'session-list']);
    expect(getPanelKind('session-list')?.Component).toBe(SessionListPanel);
    expect(getPanelKind('chat-main')?.Component).toBe(ChatMainPanel);
    expect(getPanelKind('right-tabs')?.Component).toBe(RightTabsPanel);
  });

  it('collapseMemory 声明对齐现状:左栏 global / 聊天 none / 右栏 per-session(B2a 决策)', () => {
    registerBuiltinPanels();
    expect(getPanelKind('session-list')?.collapseMemory).toBe('global');
    expect(getPanelKind('chat-main')?.collapseMemory).toBe('none');
    expect(getPanelKind('right-tabs')?.collapseMemory).toBe('per-session');
  });
});
