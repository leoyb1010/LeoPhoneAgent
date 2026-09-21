import { createContext, useContext, type ReactNode } from "react";
import type { CodingPlanUpgradeDialogTarget } from "@/settings/codingPlanUpgradeLoginRecovery.js";
import type { CodingPlanEntryInventory } from "@/hooks/useCodingPlanEntryPlanList.js";

interface CodingPlanUpgradeDialogContextValue {
  inventory: CodingPlanEntryInventory;
  openCodingPlanUpgrade: (
    target: CodingPlanUpgradeDialogTarget,
    observation?: { signal: AbortSignal; onResult: (opened: boolean) => void },
  ) => boolean;
}

const CodingPlanUpgradeDialogContext = createContext<CodingPlanUpgradeDialogContextValue | null>(
  null,
);

// [leo] 上游在这里挂载 Coding Plan 购买/升级面板（内嵌官方订阅网页、查询官方套餐与团队定价、上报购买漏斗）。
// LeoPhoneAgent 没有官方订阅：Provider 保留导出与上下文（Root.tsx 和各调用方不用改），
// 但不再查询套餐、不渲染任何弹框，openCodingPlanUpgrade 永远返回 false（等同“未打开”）。
const LEO_DISABLED_CODING_PLAN_UPGRADE: CodingPlanUpgradeDialogContextValue = {
  inventory: { entryPlanList: "", status: "ready", retry: () => {} },
  openCodingPlanUpgrade: () => false,
};

export function CodingPlanUpgradeDialogProvider({ children }: { children: ReactNode }) {
  return (
    <CodingPlanUpgradeDialogContext.Provider value={LEO_DISABLED_CODING_PLAN_UPGRADE}>
      {children}
    </CodingPlanUpgradeDialogContext.Provider>
  );
}

export function useCodingPlanUpgradeDialog() {
  const context = useContext(CodingPlanUpgradeDialogContext);
  if (!context) {
    throw new Error(
      "useCodingPlanUpgradeDialog must be used within CodingPlanUpgradeDialogProvider",
    );
  }
  return context;
}

/**
 * 可独立挂载的 conversation pane 使用可选上下文；完整 App Root 仍会注入真实购买面板。
 */
export function useOptionalCodingPlanUpgradeDialog() {
  return useContext(CodingPlanUpgradeDialogContext);
}
