/**
 * zcode-plan / Coding Plan 业务错误码与前端处理约定。
 *
 * | 场景           | code | HTTP | 前端处理 |
 * |----------------|------|------|----------|
 * | JWT 缺失/失效  | 1006 | 200  | 跳登录或重新授权 |
 * | 配额不足       | 1005 | 200  | 禁用入口，刷新配额 |
 * | 模型不可用     | 3006 | 400  | 切换到 Built-in Provider 中的其他模型 |
 * | 参数错误       | 3001 | 400  | 检查请求体 |
 * | 安全校验拒绝   | 3007 | 403  | 客户端无法完成安全校验，提示联系支持 |
 * | 模型并发上限   | 3010 | 429  | Start Plan 下走升级横幅 |
 * | 请求过频       | 3002/429 | 429 | 限流提示，稍后重试 |
 * | 闲时票据不可用 | 3102 | 400  | 单段运行时间到顶，提示新建闲时任务续跑 |
 * | 上游 HTTP 异常 | 2007 | 500  | 可重试；刷新配额，勿本地扣额度 |
 */
import { isOffPeakTicketExpiredError } from "@zcode/shared";

const PROVIDER_BUSINESS_ERROR_CODES = [
  "1006",
  "1005",
  "3006",
  "3001",
  "3007",
  "3008",
  "3009",
  "3010",
  "3002",
  "3102",
  "2007",
  "429",
] as const;

type ProviderBusinessErrorCode = (typeof PROVIDER_BUSINESS_ERROR_CODES)[number];

export type ProviderBusinessErrorUiAction =
  | "login"
  | "refresh-quota"
  | "switch-model"
  | "retry-later"
  | "upgrade";

const PROVIDER_BUSINESS_ERROR_MESSAGE_IDS: Record<ProviderBusinessErrorCode, string> = {
  "1006": "zcode.error.providerBusiness.1006",
  "1005": "zcode.error.providerBusiness.1005",
  "3006": "zcode.error.providerBusiness.3006",
  "3002": "zcode.error.providerBusiness.3002",
  "3001": "zcode.error.providerBusiness.3001",
  "3007": "zcode.error.providerBusiness.3007",
  "3008": "zcode.error.providerBusiness.3008",
  "3009": "zcode.error.providerBusiness.3009",
  "3010": "zcode.error.providerBusiness.3010",
  "3102": "zcode.error.providerBusiness.3102",
  "2007": "zcode.error.providerBusiness.2007",
  "429": "zcode.error.providerBusiness.429",
};

const PROVIDER_BUSINESS_ERROR_UI_ACTIONS: Record<
  ProviderBusinessErrorCode,
  ProviderBusinessErrorUiAction | null
> = {
  "1006": "login",
  "1005": "refresh-quota",
  "3006": "switch-model",
  "3001": null,
  // 3007 安全校验拒绝：客户端无法完成安全校验，没有可执行的恢复动作。
  "3007": null,
  // 3008/3009/3010 并发上限：Start Plan 下走升级横幅，非 Start Plan 走 upgrade 动作
  "3008": "upgrade",
  "3009": "upgrade",
  "3010": "upgrade",
  "3002": "retry-later",
  // 3102 闲时票据不可用：只能新建闲时任务续跑，横幅里的重试/切模型都救不回来。
  "3102": null,
  "2007": "retry-later",
  "429": "retry-later",
};

export function isProviderBusinessErrorCode(
  code: string | undefined,
): code is ProviderBusinessErrorCode {
  if (!code) {
    return false;
  }
  return (PROVIDER_BUSINESS_ERROR_CODES as readonly string[]).includes(code);
}

export function getProviderBusinessErrorMessageId(code: string | undefined): string | undefined {
  if (!isProviderBusinessErrorCode(code)) {
    return undefined;
  }
  return PROVIDER_BUSINESS_ERROR_MESSAGE_IDS[code];
}

export function getProviderBusinessErrorUiAction(
  code: string | undefined,
): ProviderBusinessErrorUiAction | null {
  if (!isProviderBusinessErrorCode(code)) {
    return null;
  }
  return PROVIDER_BUSINESS_ERROR_UI_ACTIONS[code];
}

/** 与 core `model-errors.ts` 中 anomaly guard 文案保持一致。 */
export const SUSPICIOUS_EMPTY_MODEL_RESULT_MESSAGE =
  "Model returned no text, no tool calls, and no usage before completing the turn.";

/**
 * 闲时票据不可用（上游 3102：票据失效或过期）。
 * 适配层会把该业务码包成 `off-peak-ticket-expired: <上游原文>` 落到 turn 错误里，
 * 外层 code 被压成 PROVIDER_BUSINESS_ERROR 等包装码时靠稳定标记兜底，
 * 否则横幅会把 "off peak ticket is invaliad or expired" 原文直接怼给用户。
 */
export function resolveOffPeakTicketExpiredBusinessCode(
  code: string | undefined,
  message: string | undefined,
): "3102" | undefined {
  if (code?.trim() === "3102") {
    return "3102";
  }
  return isOffPeakTicketExpiredError(message) ? "3102" : undefined;
}

export function isSuspiciousEmptyModelResultMessage(message: string | undefined): boolean {
  if (!message) {
    return false;
  }

  return (
    message.includes(SUSPICIOUS_EMPTY_MODEL_RESULT_MESSAGE) ||
    message.includes("Model returned no text")
  );
}
