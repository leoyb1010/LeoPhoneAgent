import type { ComponentType } from 'react';

import type { PanelKind } from '../../shared/layoutTree';

/**
 * 面板注册表 —— 布局引擎与"面板是谁"之间的唯一解耦点。
 *
 * 布局引擎(LayoutRoot/SplitView/PaneView)只做一件事:拿树节点的
 * panelKind 来这里查组件;查得到就渲染,查不到就把该 pane 整体隐藏、空间回流
 * (未安装意识的存档残留 = 平时不可见,树数据保留)。引擎对"面板是谁"零感知,
 * 未来意识面板接入 = 往本注册表多一条记录,引擎不改。
 *
 * 与 right-sidebar 的 TabKindPlugin registry 的关系:那是"右栏容器内部的 tab
 * 插件"(将来整体作为工具箱意识的内部实现),本注册表是**顶层 pane 级**面板;
 * 两层各管一层,顶层布局只消费本层。
 */

/** 所有面板组件的统一入参 —— 引擎只认识这一个形状,不为任何 kind 特化。 */
export interface PanelComponentProps {
  /** 布局树里本面板所在 pane 的节点 id。 */
  paneId: string;
}

/**
 * 折叠记忆作用域(B2a,Lizi 2026-07-07 决策:两种都支持,由面板自己声明,引擎统一执行):
 * - 'global':全局一份,持久化真身是布局树 pane.collapsed(如会话列表);
 * - 'per-session':跟会话走,引擎在会话层分桶存(如工具面板:切会话各记各的开关);
 * - 'none':没有折叠能力(chat-main:必须始终可见)。
 */
export type CollapseMemory = 'global' | 'per-session' | 'none';

export interface PanelDefinition {
  kind: PanelKind;
  Component: ComponentType<PanelComponentProps>;
  /** 折叠记忆作用域声明;读写统一走 renderer/layout/collapsePrefs.ts,不许绕开自存。 */
  collapseMemory: CollapseMemory;
}

const registry = new Map<string, PanelDefinition>();

/**
 * 注册一种面板。重复注册同 kind 采取"覆盖 + dev 告警"而非抛错 —— 注册走
 * side-effect 调用,Vite HMR 会让注册代码重跑,抛错会把热更新炸成白屏。
 */
export function registerPanelKind(definition: PanelDefinition): void {
  if (registry.has(definition.kind) && import.meta.env.DEV) {
    // eslint-disable-next-line no-console -- dev-only HMR 重复注册提示,生产不可达
    console.warn(`[panels] duplicate registration overwrites kind: ${definition.kind}`);
  }
  registry.set(definition.kind, definition);
}

/**
 * 注销一种面板(卸下意识时调用)。布局树里残留的同 kind pane 自此按
 * "未安装意识"隐藏 —— 树数据保留,重装即原位复活。幂等。
 */
export function unregisterPanelKind(kind: PanelKind): void {
  registry.delete(kind);
}

/** 查面板定义;未注册(如未安装的意识)返回 null,由调用方决定隐藏策略。 */
export function getPanelKind(kind: PanelKind): PanelDefinition | null {
  return registry.get(kind) ?? null;
}

export function hasPanelKind(kind: PanelKind): boolean {
  return registry.has(kind);
}

/** 已注册 kind 列表(诊断 / 测试用)。 */
export function listPanelKinds(): string[] {
  return [...registry.keys()];
}

/** 仅测试用:清空注册表,保证用例间隔离。 */
export function __resetPanelRegistryForTest(): void {
  registry.clear();
}
