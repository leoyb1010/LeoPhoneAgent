import { createContext, useContext, type ReactNode } from 'react';

/**
 * 内置面板桥 —— 绞杀式重构的"临时绳索"(Step A 专用,终局会消失)。
 *
 * 背景:三个既有大组件(Sidebar / 聊天路由视图 / RightSidebar)的 props 全部
 * 由 MainLayout 的本地 state 供给(折叠态、宽度、拖拽回调、per-session 记忆…)。
 * Step A 的承诺是"三个大组件一行不改、状态所有权不动",因此**由 MainLayout
 * 继续构造这三个 ReactNode**,经本 context 递给注册表里的内置面板包装组件;
 * 布局引擎只认 panelKind,对这些 props 零感知。
 *
 * 终局方向:内置功能逐批意识化后,各面板改为自管状态(或经意识 SDK),本桥
 * 随之删除 —— 不要往这里加新字段来"顺便"传别的东西,它只服务三个内置面板。
 */
export interface BuiltinPanelBridge {
  /** 会话列表(树外全高独立柱)—— MainLayout 构造的 <Sidebar .../> 节点。 */
  sessionList: ReactNode;
  /** 聊天主区 —— ContentHeader + 路由 Outlet 一整块。 */
  chatMain: ReactNode;
  /** 工具面板(现右栏)—— <RightSidebar .../> 节点。 */
  rightTabs: ReactNode;
}

const BuiltinPanelBridgeContext = createContext<BuiltinPanelBridge | null>(null);

export const BuiltinPanelBridgeProvider = BuiltinPanelBridgeContext.Provider;

/**
 * 读取内置面板桥。Provider 缺失返回 null(消费方渲染空),不抛 ——
 * 第 3 步注册表尚无上线挂载点,任何早期消费都不应炸整个 renderer。
 */
export function useBuiltinPanelBridge(): BuiltinPanelBridge | null {
  return useContext(BuiltinPanelBridgeContext);
}
