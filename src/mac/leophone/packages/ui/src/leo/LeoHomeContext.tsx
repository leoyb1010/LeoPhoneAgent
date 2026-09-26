import { createContext, useContext, type ReactNode } from "react";

import type { WorkspaceTabState } from "@/store/tabStore.js";

/**
 * [leo] 首页状态清单要跨项目读任务、点一下就打开:App 层把已打开的项目和「打开任务」交下来,
 * 草稿页深处直接取,不必沿着上游组件一层层加 props。
 */
export interface LeoHomeContextValue {
  workspaceTabs: WorkspaceTabState[];
  onSelectTask: (
    workspacePath: string,
    taskId: string,
    workspaceIdentity?: string,
    selectedRowUnreadAt?: number,
  ) => void;
}

const LeoHomeContext = createContext<LeoHomeContextValue | null>(null);

export function LeoHomeProvider({
  value,
  children,
}: {
  value: LeoHomeContextValue;
  children: ReactNode;
}) {
  return <LeoHomeContext.Provider value={value}>{children}</LeoHomeContext.Provider>;
}

export function useLeoHome(): LeoHomeContextValue | null {
  return useContext(LeoHomeContext);
}
