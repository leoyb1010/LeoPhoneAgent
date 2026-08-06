/**
 * Effort 档位 → Claude Agent SDK `extendedThinking` 参数映射。
 *
 * TODO(user-preferences-system): 实装时查 @anthropic-ai/claude-agent-sdk 的官方文档，
 *   确认 extendedThinking 参数形态（effort: string or budget_tokens: int），
 *   并 benchmark 具体的 budget_tokens 值。
 *
 * 上线前必须做的两件事：
 *   1. 查阅 @anthropic-ai/claude-agent-sdk 官方文档，确认 extendedThinking 参数的
 *      精确形态 —— 是接受 `effort: 'low' | 'medium' | 'high'` 字符串，还是只接受
 *      Anthropic Messages API 的 `budget_tokens: number`（硬契约 int）。
 *   2. Benchmark `medium` / `high` 的 budget_tokens 精确值（当前 4096 / 16384 仅为建议值）。
 *
 * 当前占位返回 `{ budget_tokens: number }` 形态，假设 SDK 接受 Anthropic Messages
 * API 的经典入参。如果未来确认 SDK 暴露了更高层的 `{ effort: Effort }` 参数，
 * 直接改这里一处即可，调用方无感。
 *
 * 本轮**无消费方**，此文件仅为未来的 CC Agent ChatInputBox / session store 预置工具。
 */

import type { Effort } from '@/lib/userPreferences.types';

export const EFFORT_TO_BUDGET_TOKENS: Record<Effort, number> = {
  minimal: 0, // Codex-only; CC 没此档, 等价 low
  low: 0, // 不启用 extended thinking
  medium: 4096, // 建议值，benchmark 待确认
  high: 16384, // 建议值，benchmark 待确认
  xhigh: 32768, // Opus 4.7 only; 其他模型 fallback 到 high
  max: 65536, // Opus 4.6/4.7 only
};

export function effortToSdkExtendedThinking(effort: Effort): { budget_tokens: number } {
  return { budget_tokens: EFFORT_TO_BUDGET_TOKENS[effort] };
}
