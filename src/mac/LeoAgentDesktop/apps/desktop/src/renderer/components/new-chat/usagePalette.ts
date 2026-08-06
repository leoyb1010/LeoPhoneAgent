/**
 * usagePalette — 用量仪表盘的模型配色 (单色浓度阶梯)。
 *
 * 堆叠柱状图 (UsageDailyBars) 分段的 rank → 颜色映射集中在这里, 与
 * HomeUsageDashboard 传入的 colorOrder (payload.models 排序, main 按可比金额
 * 降序) 共用同一套 rank 语义。前 N 名模型各占一档浓度, 之后统一最后一档 ("其它")。
 */

/** 单独占一档配色的模型数上限, 其余合并为"其它"档。 */
export const USAGE_TOP_MODELS = 5;

/** rank 0..USAGE_TOP_MODELS 的浓度阶梯 (最后一档给"其它")。 */
const RANK_MIX = [1, 0.75, 0.55, 0.4, 0.3, 0.18];

/** rank → CSS 颜色 (color-mix 在 --accent-emphasis 上做透明度阶梯)。 */
export function usageRankColor(rank: number): string {
  const mix = RANK_MIX[Math.min(rank, RANK_MIX.length - 1)];
  return `color-mix(in srgb, var(--accent-emphasis) ${mix * 100}%, var(--surface-chip))`;
}

/** (agentKind, model) → 配色 key (网关模型 id 可能跨 agent 撞名)。 */
export function usageModelKey(agentKind: string, model: string): string {
  return `${agentKind} ${model}`;
}

/** key → rank: 在 colorOrder 中的位置; 不在前 N 名 → "其它"档。 */
export function usageRankOf(colorOrder: string[], key: string): number {
  const idx = colorOrder.indexOf(key);
  return idx >= 0 ? idx : colorOrder.length;
}
