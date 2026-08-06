/**
 * useRegisterCCAgentSidebar — 把 CC Agent 的项目/对话侧栏注入 Shell 的 sidebar
 * 上半槽位。
 * ---------------------------------------------------------------------------
 * 背景:CCAgentSidebarUpper 渲染在 Shell 的 upperContent 槽里(不在各 Feature
 * Layout 的 React 子树内),靠 useRegisterSidebarUpper「卸载不清空」的语义保持
 * 实例常驻。但该槽位初始为 null,只有在某个 Feature Layout 主动注册后才有内容。
 *
 * /cc-agent 与 /skillhub、/issues 是 MainLayout 下的**同级**路由 —— 之前只有
 * CCAgentFeatureLayout 注册侧栏,SkillHub / IssueTracker 靠"cc-agent 已经挂载过
 * 一次、实例还在"来白嫖侧栏。可一旦用户冷启动(reload / deep-link / 新窗口)直接
 * 落到 /skillhub 或 /issues,CCAgentFeatureLayout 从未挂载,槽位停在 null,左栏
 * 整块空白。
 *
 * 修法:所有「复用 cc-agent 项目/对话侧栏」的 Feature Layout 都显式调用本 hook,
 * 注册同一个 <CCAgentSidebarUpper /> 组件类型。React 按"组件类型 + 位置"协调:
 * 多个 Layout 注册的是同一类型,导航切换时只 reconcile、不 remount,实例内部
 * 状态(滚动位置 / 展开分组等)得以保留;冷启动直接进入时则首次播种,不再空白。
 */
import { useMemo } from 'react';

import { useRegisterSidebarUpper } from '../feature-context';
import { CCAgentSidebarUpper } from './CCAgentSidebarUpper';

export function useRegisterCCAgentSidebar(): void {
  // useMemo 稳定 node 引用,避免每次 render 都触发注册 effect。
  const upper = useMemo(() => <CCAgentSidebarUpper />, []);
  useRegisterSidebarUpper(upper);
}
