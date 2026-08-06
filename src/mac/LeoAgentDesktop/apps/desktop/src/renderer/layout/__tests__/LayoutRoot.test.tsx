// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createDefaultLayout, type Layout } from '../../../shared/layoutTree';
import { BuiltinPanelBridgeProvider, type BuiltinPanelBridge } from '../../panels/BuiltinPanelBridge';
import { __resetBuiltinPanelsForTest } from '../../panels/builtinPanels';
import { __resetPanelRegistryForTest } from '../../panels/registry';
import { LayoutRoot } from '../LayoutRoot';

/** stub electronAPI.layout:同步返回给定树 + 可手动触发 onChanged。 */
let currentLayout: Layout;
let changedListeners: Array<(payload: { layout: Layout }) => void>;

function stubElectronLayoutApi(): void {
  changedListeners = [];
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    layout: {
      getStateSync: () => ({ layout: currentLayout }),
      onChanged: (cb: (payload: { layout: Layout }) => void) => {
        changedListeners.push(cb);
        return () => {
          changedListeners = changedListeners.filter((l) => l !== cb);
        };
      },
    },
  };
}

function emitLayoutChanged(next: Layout): void {
  currentLayout = next;
  act(() => {
    changedListeners.forEach((cb) => cb({ layout: next }));
  });
}

const bridge: BuiltinPanelBridge = {
  sessionList: <div data-testid="p-sessions" />,
  chatMain: <div data-testid="p-chat" />,
  rightTabs: <div data-testid="p-right" />,
};

function renderLayoutRoot() {
  return render(
    <BuiltinPanelBridgeProvider value={bridge}>
      <div data-testid="row">
        <LayoutRoot />
      </div>
    </BuiltinPanelBridgeProvider>,
  );
}

/** row 容器 direct children 的 testid 顺序 —— 断言"顺序由树驱动"。 */
function rowChildTestIds(): string[] {
  return [...screen.getByTestId('row').children].map((el) => el.getAttribute('data-testid') ?? '?');
}

beforeEach(() => {
  currentLayout = createDefaultLayout();
  stubElectronLayoutApi();
});

afterEach(() => {
  cleanup();
  __resetPanelRegistryForTest();
  __resetBuiltinPanelsForTest();
});

describe('LayoutRoot · 树驱动的顺序与在场', () => {
  it('默认树:chat 在前、right 在后,相邻可见面板之间有引擎分割线', () => {
    renderLayoutRoot();
    expect(rowChildTestIds()).toEqual(['p-chat', 'layout-divider', 'p-right']);
  });

  it('交换 children 顺序的树:渲染顺序跟随(第 5 步 dev 交换命令的引擎基础)', () => {
    const swapped = createDefaultLayout();
    (swapped.content as { children: unknown[] }).children.reverse();
    currentLayout = swapped;
    renderLayoutRoot();
    expect(rowChildTestIds()).toEqual(['p-right', 'layout-divider', 'p-chat']);
  });

  it('layout:changed 热更新:收到新树后重排,无需重新挂载', () => {
    renderLayoutRoot();
    expect(rowChildTestIds()).toEqual(['p-chat', 'layout-divider', 'p-right']);

    const swapped = createDefaultLayout();
    (swapped.content as { children: unknown[] }).children.reverse();
    emitLayoutChanged(swapped);
    expect(rowChildTestIds()).toEqual(['p-right', 'layout-divider', 'p-chat']);
  });

  it('未注册 panelKind(未安装意识残留)整个 pane 隐藏,不留孤儿分割线', () => {
    const withGhost = createDefaultLayout();
    (withGhost.content as { children: { node: { panelKind: string } }[] }).children[1].node.panelKind =
      'ghost:not-installed';
    currentLayout = withGhost;
    renderLayoutRoot();
    expect(rowChildTestIds()).toEqual(['p-chat']);
  });

  it('接管态(suppressNonChatPanels):只渲染 chat-main,其余面板与分割线歇业', () => {
    render(
      <BuiltinPanelBridgeProvider value={bridge}>
        <div data-testid="row-suppressed">
          <LayoutRoot suppressNonChatPanels />
        </div>
      </BuiltinPanelBridgeProvider>,
    );
    const ids = [...screen.getByTestId('row-suppressed').children].map(
      (el) => el.getAttribute('data-testid') ?? '?',
    );
    expect(ids).toEqual(['p-chat']);
  });

  it('卸载后重新 mount 不泄漏 onChanged 订阅', () => {
    const { unmount } = renderLayoutRoot();
    expect(changedListeners).toHaveLength(1);
    unmount();
    expect(changedListeners).toHaveLength(0);
  });
});
