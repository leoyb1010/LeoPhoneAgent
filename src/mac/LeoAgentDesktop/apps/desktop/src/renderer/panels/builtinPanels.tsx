import type { ReactNode } from 'react';

import { useBuiltinPanelBridge } from './BuiltinPanelBridge';
import { registerPanelKind, type PanelComponentProps } from './registry';

/**
 * 三个内置面板的包装组件 —— "只包不改":不 import 任何大组件,只从
 * BuiltinPanelBridge 取 MainLayout 构造好的 ReactNode 原样渲染。
 * 这保证布局引擎挂载前零行为变化,LayoutRoot 挂载后
 * 三个大组件的构造与状态所有权仍完整留在 MainLayout。
 */

function bridgeSlot(node: ReactNode | undefined): ReactNode {
  // Provider 缺失(bridge = null)时渲染空 —— 不抛、不占位,pane 自然为空容器。
  return node ?? null;
}

/** 会话列表面板(panelKind: 'session-list')。 */
export function SessionListPanel(_props: PanelComponentProps): ReactNode {
  return bridgeSlot(useBuiltinPanelBridge()?.sessionList);
}

/** 聊天主区面板(panelKind: 'chat-main')。 */
export function ChatMainPanel(_props: PanelComponentProps): ReactNode {
  return bridgeSlot(useBuiltinPanelBridge()?.chatMain);
}

/** 工具面板 = 现右栏整体(panelKind: 'right-tabs')。 */
export function RightTabsPanel(_props: PanelComponentProps): ReactNode {
  return bridgeSlot(useBuiltinPanelBridge()?.rightTabs);
}

let registered = false;

/**
 * 注册三个内置面板。显式调用而非 import 副作用 —— 由布局引擎入口
 * (LayoutRoot 模块)在挂载前调用,幂等。
 */
export function registerBuiltinPanels(): void {
  if (registered) return;
  registered = true;
  // collapseMemory 对齐现状:左栏折叠全局一份、右栏按会话分桶、聊天主区不可折叠。
  registerPanelKind({ kind: 'session-list', Component: SessionListPanel, collapseMemory: 'global' });
  registerPanelKind({ kind: 'chat-main', Component: ChatMainPanel, collapseMemory: 'none' });
  registerPanelKind({ kind: 'right-tabs', Component: RightTabsPanel, collapseMemory: 'per-session' });
}

/** 仅测试用:允许用例重复走注册路径。 */
export function __resetBuiltinPanelsForTest(): void {
  registered = false;
}
