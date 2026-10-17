import { describe, expect, it, beforeEach, vi } from "vitest";
import { BIGMODEL_PROVIDER_ID, ZAI_PROVIDER_ID } from "@zcode/shared";

// [leo] Leo has no official coding/team/start plans: the provider-family plan selection refresh
// (refreshLatestModelProviderFamilySelection*, refreshRestoredOAuthProviderFamilyAfterStartup) was
// removed, so only the generic OAuth callback success handling is covered here.

const reportAppTelemetryEventMock = vi.fn(async () => {});
const resolveProviderTelemetryLabelMock = vi.fn((providerId: string) =>
  providerId === ZAI_PROVIDER_ID ? "z.ai" : "bigmodel",
);

vi.mock("@/lib/appTelemetry.js", () => ({
  reportAppTelemetryEvent: reportAppTelemetryEventMock,
  resolveProviderTelemetryLabel: resolveProviderTelemetryLabelMock,
}));

vi.mock("@/logger.js", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

describe("handleOAuthCallbackSuccess", () => {
  beforeEach(() => {
    reportAppTelemetryEventMock.mockClear();
    resolveProviderTelemetryLabelMock.mockClear();
  });

  it("应用登录回调会更新 user、清理错误并上报登录埋点", async () => {
    const { handleOAuthCallbackSuccess } = await import("@/root/useRootOAuthEffects.js");
    const setUser = vi.fn();
    const setOAuthError = vi.fn();
    const refreshProviderState = vi.fn(async () => {});
    const setProviderFamilyDomain = vi.fn(async () => {});
    const platform = {
      reportTelemetryEvent: vi.fn(async () => {}),
    };

    await handleOAuthCallbackSuccess({
      result: {
        kind: "session",
        provider: BIGMODEL_PROVIDER_ID,
        userInfo: {
          id: "user-1",
          username: "bigmodel-user",
          displayName: "BigModel User",
        },
      },
      platform,
      refreshProviderState,
      setProviderFamilyDomain,
      setUser,
      setOAuthError,
    });

    expect(setUser).toHaveBeenCalledWith({
      id: "user-1",
      username: "bigmodel-user",
      displayName: "BigModel User",
    });
    expect(setOAuthError).toHaveBeenCalledWith(null);
    expect(setProviderFamilyDomain).toHaveBeenCalledWith(BIGMODEL_PROVIDER_ID);
    expect(refreshProviderState).toHaveBeenCalledOnce();
    expect(reportAppTelemetryEventMock).toHaveBeenCalledTimes(1);
  });
});
