// ============================================================
// [leo] 过早的 length 截断：先压缩一次再重试本步
// ============================================================
// 上游对 finishReason=length 一律"保存半截回答 + 追加续写提示"，最多 3 次（见
// runtime/methods/turn-output-token-continuation.ts）。但当上下文快满时，本步的
// maxOutputTokens 会被 resolveModelStepMaxOutputTokens 压到只剩几千 token：这种截断不是模型
// 真的写太长，而是窗口不够。在满窗口上续写只会让上下文更满、每次只多挤出一点。
// 判定为"过早截断"（预算被上下文压缩到小于模型基线且不超过 8K）时：
//   1. 复用上游的 reactive compact（同一模型步只压一次，受 rapid-refill 熔断约束）；
//   2. 压缩成功则丢弃这次半截回答：assistant 消息保留在会话记录里（UI / transcript 可见），
//      但标记 providerVisibility=hidden 且不进入请求历史，之后的请求与冷恢复都看不到它；
//   3. 压缩不成立则回到上游续写逻辑，行为不变。

import type { Logger } from "@zcode/contracts";
import { createModelContextExceededFinishError } from "../helpers/model-errors.js";

export const LEO_PREMATURE_LENGTH_MAX_OUTPUT_TOKENS = 8_192;
/** 被丢弃的截断回答 / 超窗失败的 assistant 消息的 finish 标记。 */
export const LEO_PREMATURE_LENGTH_DISCARDED_FINISH = "leo_premature_length_discarded";
export const LEO_CONTEXT_OVERFLOW_DISCARDED_FINISH = "leo_context_overflow_discarded";

export interface LeoStepOutputBudget {
  /** 模型声明（或默认）的单次输出上限。 */
  baseline: number;
  /** 本步实际发送的 maxOutputTokens（按剩余窗口压缩后）。 */
  step: number;
}

export function isLeoPrematureLengthStop(input: {
  budget: LeoStepOutputBudget | undefined;
  outputTokenContinuation: "continue" | "exhausted" | "none";
  reactiveCompactAttempted: boolean;
}): boolean {
  if (input.outputTokenContinuation === "none" || input.reactiveCompactAttempted) return false;
  const budget = input.budget;
  if (!budget) return false;
  return budget.step < budget.baseline && budget.step <= LEO_PREMATURE_LENGTH_MAX_OUTPUT_TOKENS;
}

/**
 * 过早截断的恢复流程：判定 → reactive compact（上游 recoverModelStepAfterContextExceeded）→
 * 成功则把这次 assistant 消息收尾成"已丢弃、对 provider 隐藏"。返回 true 表示调用方应重试本步。
 */
export async function recoverLeoPrematureLengthStop(input: {
  budget: LeoStepOutputBudget | undefined;
  outputTokenContinuation: "continue" | "exhausted" | "none";
  reactiveCompactAttempted: boolean;
  rapidRefillBlocked: boolean;
  finishReason: string | undefined;
  rawFinishReason: string | undefined;
  responseLength: number;
  recover: (contextError: unknown) => Promise<boolean>;
  discard: () => Promise<void>;
  logger?: Logger;
  logContext: Record<string, unknown>;
}): Promise<boolean> {
  if (input.rapidRefillBlocked || !isLeoPrematureLengthStop(input)) return false;
  const contextError = createModelContextExceededFinishError({
    finishReason: input.finishReason,
    rawFinishReason: input.rawFinishReason,
  });
  if (!(await input.recover(contextError))) return false;
  input.logger?.warn("Premature length stop discarded after compaction", {
    ...input.logContext,
    event: "leo.model.premature_length_compacted",
    module: "core.runtime",
    outputBudgetTokens: input.budget?.step,
    baselineOutputTokens: input.budget?.baseline,
    discardedResponseLength: input.responseLength,
    status: "waiting",
  });
  await input.discard();
  return true;
}
