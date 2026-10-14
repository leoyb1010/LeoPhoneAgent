import type { IntlInstance } from "@/i18n/IntlProvider.js";

type UsageErrorSurface = "stats";

const CREDENTIAL_ERROR_PATTERNS = [
  /token\s+(expired|incorrect)/i,
  /expired.*token/i,
  /incorrect.*token/i,
  /invalid.*(?:api\s*)?key/i,
  /(?:api\s*)?key.*invalid/i,
  /unauthorized/i,
  /forbidden/i,
  /\b40[13]\b/,
  /认证|鉴权|授权|密钥|无效|过期/i,
];

export function isUsageCredentialError(error: string | null | undefined): boolean {
  if (!error) {
    return false;
  }

  return CREDENTIAL_ERROR_PATTERNS.some((pattern) => pattern.test(error));
}

export function formatUsageErrorMessage(
  intl: IntlInstance,
  surface: UsageErrorSurface,
  error: string | null | undefined,
): string {
  // 供应商接口会返回英文鉴权错误，直接展示会让用户不知道下一步怎么排查。
  // 这里统一把可恢复的 key/OAuth 问题翻译成用户可执行的检查项，原始错误仍由调用方写入日志。
  if (isUsageCredentialError(error)) {
    return intl.formatMessage({ id: `usage.error.${surface}.credential` });
  }

  return intl.formatMessage({ id: `usage.error.${surface}.generic` });
}
