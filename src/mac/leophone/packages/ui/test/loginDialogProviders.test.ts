import {
  BIGMODEL_PROVIDER_ID,
  type OAuthProviderMeta,
  ZAI_PROVIDER_ID,
} from "@zcode/shared";
import { describe, expect, it } from "vitest";
import { resolveLoginRetryProvider } from "@/WelcomeScreen.js";

function createProvider(
  overrides: Partial<OAuthProviderMeta>,
): OAuthProviderMeta {
  return {
    id: overrides.id ?? "custom-oauth",
    displayName: overrides.displayName ?? "Custom OAuth",
    enabled: overrides.enabled ?? true,
    order: overrides.order ?? 10,
  };
}

// [leo] resolveVisibleLoginProviders 不再导出：LeoBot 不展示 Z.ai / BigModel 平台账号登录入口（恒为空）。

describe("resolveLoginRetryProvider", () => {
  it("OAuth 失败后优先沿用刚才失败的 provider，而不是回退到 providers[0]", () => {
    const providers = [
      createProvider({
        id: BIGMODEL_PROVIDER_ID,
        displayName: "BigModel",
        order: 0,
      }),
      createProvider({
        id: ZAI_PROVIDER_ID,
        displayName: "Z.ai",
        order: 1,
      }),
    ];

    expect(
      resolveLoginRetryProvider({
        pendingProvider: null,
        lastAttemptProvider: ZAI_PROVIDER_ID,
        providers,
      }),
    ).toBe(ZAI_PROVIDER_ID);
  });

  it("等待态取消前仍优先使用当前 pending provider", () => {
    const providers = [
      createProvider({
        id: BIGMODEL_PROVIDER_ID,
        displayName: "BigModel",
        order: 0,
      }),
    ];

    expect(
      resolveLoginRetryProvider({
        pendingProvider: ZAI_PROVIDER_ID,
        lastAttemptProvider: BIGMODEL_PROVIDER_ID,
        providers,
      }),
    ).toBe(ZAI_PROVIDER_ID);
  });
});
