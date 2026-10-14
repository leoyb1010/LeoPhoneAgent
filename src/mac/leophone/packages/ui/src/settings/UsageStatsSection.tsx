import { AppUsagePanel } from "@/settings/usage-stats/AppUsagePanel.js";

// [leo] 使用统计只保留本机「应用用量」；上游的 Coding Plan 额度 / 用量 tab（官方账号数据）已删除。
export function UsageStatsSection() {
  return <AppUsagePanel />;
}
