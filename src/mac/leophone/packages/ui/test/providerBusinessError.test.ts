import { describe, expect, it } from "vitest";
import { normalizeZCodeUiError } from "@/lib/zcodeUiError.js";
import {
  getProviderBusinessErrorMessageId,
  isProviderBusinessErrorCode,
} from "@/lib/providerBusinessError.js";

// [leo] Leo 没有官方 Coding Plan / Start Plan / GLM 额度套餐，额度快照刷新、GLM 额度升级横幅、
// Start Plan 并发/额度耗尽归一等辅助函数已删除，对应用例一并移除。
describe("providerBusinessError", () => {
  it("recognizes provider business codes for localized banners", () => {
    expect(isProviderBusinessErrorCode("3007")).toBe(true);
    expect(getProviderBusinessErrorMessageId("1005")).toBe(
      "zcode.error.providerBusiness.1005",
    );
    expect(isProviderBusinessErrorCode("3010")).toBe(true);
    expect(getProviderBusinessErrorMessageId("3010")).toBe(
      "zcode.error.providerBusiness.3010",
    );
    expect(isProviderBusinessErrorCode("invalid_model_request")).toBe(false);
  });

  it("从 detail provider_code 读取业务码", () => {
    const normalized = normalizeZCodeUiError({
      code: "PROVIDER_BUSINESS_ERROR",
      message: "Provider request failed",
      detail: "provider_code=1308 upstream quota limit",
    });

    expect(normalized.code).toBe("1308");
  });
});
