// @vitest-environment jsdom
import { renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { IServiceAccessor } from "@zcode/services";
import type { IPlatformService } from "@zcode/shared";
import { useRootOAuthEffects } from "@/root/useRootOAuthEffects.js";
import { logger } from "@/logger.js";
vi.mock("@/hooks/useAlertDialog.js", () => ({ useAlertDialog: () => vi.fn() }));
vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({ intl: { formatMessage: ({ id }: { id: string }) => id } }),
}));
vi.mock("@/logger.js", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    lifecycle: { warn: vi.fn() },
  },
}));

describe("Root 账号刷新生命周期", () => {
  // [leo] Leo removed the official-account connection-loss subscription
  // (useAccountConnectionLossNotification -> providerSettingsService.onDidChange); only the
  // "startup refresh failure is logged and does not throw" half of this contract still applies.
  it("启动刷新失败后仅记录告警，不中断启动流程", async () => {
    const dispose = vi.fn();
    const onDidChange = vi.fn(() => ({ dispose }));
    const services = {
      oauthService: { restoreCachedSessionState: vi.fn(async () => ({ status: "signed-out" })) },
      broadcastService: { onMessage: vi.fn(() => ({ dispose: vi.fn() })) },
      providerSettingsService: {
        onDidChange,
        getView: vi.fn(async () => ({ revision: 1, providers: [] })),
      },
    } as unknown as IServiceAccessor;
    const refreshProviderState = vi.fn(async () => {
      throw new Error("temporary refresh failure");
    });
    // 订阅已拆到独立 hook；真实挂载全部 effect，不能再假定第一个 effect 负责订阅。
    const { unmount } = renderHook(() =>
      useRootOAuthEffects({
        accountIntentKey: "test-account/individual",
        platform: {
          onOAuthCallback: vi.fn(() => vi.fn()),
          notifyRendererReady: vi.fn(),
        } as unknown as IPlatformService,
        services,
        refreshProviderState,
        setUser: vi.fn(),
        setIsRestoringOAuthSession: vi.fn(),
        setOAuthError: vi.fn(),
        oauthPollingActive: false,
        setOAuthPollingActive: vi.fn(),
        markOAuthSuccess: vi.fn(),
        onReauthenticationRequired: vi.fn(),
      }),
    );
    try {
      await waitFor(() =>
        expect(logger.warn).toHaveBeenCalledWith("[Root] 启动账号配置刷新失败，继续观察后续更新", {
          error: expect.any(Error),
        }),
      );
      expect(refreshProviderState).toHaveBeenCalledOnce();
      expect(onDidChange).not.toHaveBeenCalled();
    } finally {
      unmount();
    }
    expect(dispose).not.toHaveBeenCalled();
  });
});
