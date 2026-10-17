import type { ZCodePermissionRequest } from "@zcode/shared";

/** [leo][wp-31] runtime 风险档 → 审批卡风险条:low 不画,medium 提醒色,high/critical 危险色。 */
export function resolveLeoApprovalRisk(
  riskLevel: ZCodePermissionRequest["riskLevel"],
): "medium" | "high" | undefined {
  if (riskLevel === "medium") return "medium";
  if (riskLevel === "high" || riskLevel === "critical") return "high";
  return undefined;
}
