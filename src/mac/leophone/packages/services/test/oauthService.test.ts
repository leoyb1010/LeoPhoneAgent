import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ApiError,
  BIGMODEL_PROVIDER_ID,
  CREDENTIAL_DECRYPT_ERROR_CODE,
  ZAI_PROVIDER_ID,
  type ApiClient,
  type OAuthProviderId,
  type OAuthTokenSet,
  type OAuthUserProfile,
} from "@zcode/shared";
import { ZAI_OAUTH_PROVIDER_CONFIG } from "../src/oauth/providers/zaiProviderConfig.js";
import { ZaiProviderAdapter } from "../src/oauth/providers/zaiProviderAdapter.js";
import type { ICredentialService } from "../src/credential/credential.js";
import type { OAuthProviderAdapter } from "../src/oauth/providers/index.js";
import { OAuthService } from "../src/oauth/oauthService.js";
import { OAuthCredentialRepo } from "../src/oauth/repo/oauthCredentialRepo.js";

const DESKTOP_OAUTH_CALLBACK_URI = "zcode://oauth/callback";

// Windows 机器上设置了 ZAI_TEST_OAUTH_ORIGIN 等环境变量，会覆盖测试预期的 test 端点值
// 过滤掉这些可能污染测试的环境变量
const OAUTH_ENV_KEYS_TO_OMIT = new Set([
  "ZCODE_ENV",
  "ZCODE_ENDPOINT_ORIGIN",
  "ZAI_TEST_OAUTH_ORIGIN",
  "ZAI_PRODUCTION_OAUTH_ORIGIN",
  "ZAI_OAUTH_ORIGIN",
  "ZAI_TEST_OAUTH_CLIENT_ID",
  "ZAI_PRODUCTION_OAUTH_CLIENT_ID",
  "ZAI_OAUTH_CLIENT_ID",
  "BIGMODEL_TEST_API_BASE_URL",
  "BIGMODEL_PRODUCTION_API_BASE_URL",
  "BIGMODEL_API_BASE_URL",
  "ZAI_TEST_BUSINESS_BASE_URL",
  "ZAI_PRODUCTION_BUSINESS_BASE_URL",
  "ZAI_BUSINESS_BASE_URL",
  "ZCODE_TEST_BASE_URL",
  "ZCODE_PRODUCTION_BASE_URL",
  "ZCODE_BASE_URL",
]);
const cleanProcessEnv = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => !OAUTH_ENV_KEYS_TO_OMIT.has(key)),
) as Record<string, string | undefined>;

const credentialStore = new Map<string, string>();

const credentialServiceStub: ICredentialService = {
  load: async (key: string) => credentialStore.get(key) ?? null,
  save: async (key: string, value: string) => {
    credentialStore.set(key, value);
  },
  delete: async (key: string) => {
    credentialStore.delete(key);
  },
};

const OAUTH_SESSION_CREDENTIAL_KEYS = [
  "oauth:active_provider",
  "oauth:bigmodel:access_token",
  "oauth:bigmodel:refresh_token",
  "oauth:bigmodel:user_info",
  "oauth:zai:access_token",
  "oauth:zai:refresh_token",
  "oauth:zai:user_info",
  "zcodejwttoken",
] as const;

function expectDeletedOAuthSessionCredentials(
  deletedKeys: string[],
  additionalKeys: readonly string[] = [],
) {
  expect(new Set(deletedKeys)).toEqual(
    new Set([...OAUTH_SESSION_CREDENTIAL_KEYS, ...additionalKeys]),
  );
  expect(deletedKeys).not.toContain("auth_token");
  expect(deletedKeys).not.toContain("refresh_token");
}

function createMockCredentialDecryptError(message = "Serialized credential decrypt failure") {
  return Object.assign(new Error(message), { code: CREDENTIAL_DECRYPT_ERROR_CODE });
}

function expectProviderLogoutNotifications(
  onProviderLogout: ReturnType<typeof vi.fn>,
  expectedProviders: readonly OAuthProviderId[],
) {
  expect(onProviderLogout).toHaveBeenCalledTimes(expectedProviders.length);
  expect(new Set(onProviderLogout.mock.calls.map(([provider]) => provider))).toEqual(
    new Set(expectedProviders),
  );
}

function createMockApiClient(mockFetch: typeof fetch): ApiClient {
  return {
    request: mockFetch,
  };
}

function createBigModelService(
  overrides?: ConstructorParameters<typeof OAuthService>[1],
): OAuthService {
  return new OAuthService(credentialServiceStub, {
    env: {
      ...cleanProcessEnv,
      BIGMODEL_OAUTH_APP_SECRET: "unit-test-secret",
    },
    apiClient: createMockApiClient(vi.fn<typeof fetch>()),
    ...overrides,
  });
}

function createZaiBusinessLoginResponse(accessToken = "zai_business_access_token"): Response {
  return new Response(
    JSON.stringify({
      code: 200,
      success: true,
      data: {
        access_token: accessToken,
        expires_in: 3600,
      },
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

afterEach(() => {
  credentialStore.clear();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("oauthService", () => {
  it("rejects a late polling callback after timeout without persisting credentials", async () => {
    vi.useFakeTimers();
    let now = 2_000_000_000_000;
    const mockFetch = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (url.endsWith("/api/v1/oauth/cli/init")) {
        return new Response(
          JSON.stringify({
            code: 0,
            data: {
              authorize_url: "https://chat.z.ai/api/oauth/authorize?state=expired-polling-state",
              expires_at: (now + 5_000) / 1_000,
              flow_id: "expired-polling-flow",
              poll_interval_sec: 1,
              poll_token: "poll-token",
            },
          }),
          { status: 200 },
        );
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    const baseAdapter = new ZaiProviderAdapter(
      {
        ...ZAI_OAUTH_PROVIDER_CONFIG,
        enabled: true,
      },
      createMockApiClient(mockFetch),
    );
    const exchangeToken = vi.spyOn(baseAdapter, "exchangeToken").mockImplementation(async () => {
      throw new Error("exchange should not run");
    });
    const service = createBigModelService({
      apiClient: createMockApiClient(mockFetch),
      now: () => now,
      adapters: [baseAdapter],
    });

    const started = await service.startOAuthWithPolling(ZAI_PROVIDER_ID);
    credentialStore.set("oauth:zai:access_token", "existing-token");
    now += 5_000;
    await vi.advanceTimersByTimeAsync(5_000);

    await expect(
      service.handleCallback(`zcode://oauth/callback?state=${started.state}&code=late-code`),
    ).rejects.toThrow("OAuth state 不匹配或已过期");
    expect(exchangeToken).not.toHaveBeenCalled();
    expect(credentialStore.get("oauth:zai:access_token")).toBe("existing-token");
  });

  it("reads the temporary expiring attribution record written by an earlier branch revision", async () => {
    await credentialServiceStub.save(
      "oauth:login_attribution",
      JSON.stringify({
        params: { channel_id: "migrated-channel", utm_campaign: "launch" },
        expiresAt: 1,
      }),
    );
    const repo = new OAuthCredentialRepo(credentialServiceStub);

    await expect(repo.loadLoginAttribution()).resolves.toEqual({
      channel_id: "migrated-channel",
      utm_campaign: "launch",
    });
  });

  it("缺少 apiClient 注入时会立即报错", () => {
    expect(
      () =>
        new OAuthService(credentialServiceStub, {
          env: {
            ...process.env,
            BIGMODEL_OAUTH_APP_SECRET: "unit-test-secret",
          },
        }),
    ).toThrow(/ApiClient/);
  });

  // Windows 机器上设置了 ZAI_TEST_OAUTH_ORIGIN 等环境变量，会覆盖测试预期的 test 端点值

  it("maps zai backend expires_in into OAuthTokenSet expiresAt", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    const adapter = new ZaiProviderAdapter(
      {
        ...ZAI_OAUTH_PROVIDER_CONFIG,
        enabled: true,
      },
      createMockApiClient(fetchMock),
    );
    const now = 1_800_000_000_000;

    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          code: 0,
          msg: "",
          data: {
            token: "zcode_backend_jwt",
            zai: {
              access_token: "zai_oauth_access_token",
            },
            expires_in: 86400,
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    fetchMock.mockResolvedValueOnce(createZaiBusinessLoginResponse());

    await expect(
      adapter.exchangeToken(
        { code: "zai-code-001", state: "state-001" },
        {
          providerId: ZAI_PROVIDER_ID,
          state: "state-001",
          redirectUri: ZAI_OAUTH_PROVIDER_CONFIG.redirectUri,
          now: () => now,
        },
      ),
    ).resolves.toEqual({
      accessToken: "zai_business_access_token",
      zcodeJwtToken: "zcode_backend_jwt",
      expiresAt: now + 86400 * 1000,
    });
  });

  it("logs zai backend token request without exposing full oauth code", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    const consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const adapter = new ZaiProviderAdapter(
      {
        ...ZAI_OAUTH_PROVIDER_CONFIG,
        enabled: true,
      },
      createMockApiClient(fetchMock),
    );
    const fullCode = "abcdefghijklmnopqrstuvwxyz";

    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          code: 0,
          msg: "",
          data: {
            token: "zcode_backend_jwt",
            zai: {
              access_token: "zai_oauth_access_token",
            },
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    fetchMock.mockResolvedValueOnce(createZaiBusinessLoginResponse());

    await adapter.exchangeToken(
      { code: fullCode, state: "state-001" },
      {
        providerId: ZAI_PROVIDER_ID,
        state: "state-001",
        redirectUri: ZAI_OAUTH_PROVIDER_CONFIG.redirectUri,
        now: () => 1_800_000_000_000,
      },
    );

    expect(consoleLogSpy).toHaveBeenCalledWith(
      expect.stringContaining("[zaiOAuth]"),
      "token request",
      {
        method: "POST",
        url: ZAI_OAUTH_PROVIDER_CONFIG.tokenUrl,
        headers: { "Content-Type": "application/json" },
        body: {
          provider: ZAI_PROVIDER_ID,
          code: "abcd...wxyz",
          codeLength: 26,
          redirect_uri: ZAI_OAUTH_PROVIDER_CONFIG.redirectUri,
          state: "state-001",
        },
      },
    );
    expect(JSON.stringify(consoleLogSpy.mock.calls)).not.toContain(fullCode);
  });

  it("logs zai final token response body without exposing full token", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    const consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const adapter = new ZaiProviderAdapter(
      {
        ...ZAI_OAUTH_PROVIDER_CONFIG,
        enabled: true,
      },
      createMockApiClient(fetchMock),
    );
    const fullToken = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.mock-signature";
    const fullZaiAccessToken = "zai_oauth_access_token_should_not_leak";

    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          code: 0,
          msg: "",
          data: {
            token: fullToken,
            zai: {
              access_token: fullZaiAccessToken,
            },
            expires_in: 86400,
            user: {
              user_id: "u_xxxxx",
              email: "user@example.com",
              avatar: "https://example.com/avatar.png",
              created_at: "2026-04-27T10:00:00Z",
            },
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    fetchMock.mockResolvedValueOnce(createZaiBusinessLoginResponse());

    await adapter.exchangeToken(
      { code: "zai-code-001", state: "state-001" },
      {
        providerId: ZAI_PROVIDER_ID,
        state: "state-001",
        redirectUri: ZAI_OAUTH_PROVIDER_CONFIG.redirectUri,
        now: () => 1_800_000_000_000,
      },
    );

    expect(consoleLogSpy).toHaveBeenCalledWith(
      expect.stringContaining("[zaiOAuth]"),
      "token final response body",
      {
        code: 0,
        msg: "",
        data: {
          token: "eyJh...ture",
          tokenLength: fullToken.length,
          zai: {
            access_token: "zai_...leak",
            accessTokenLength: fullZaiAccessToken.length,
          },
          expires_in: 86400,
          user: {
            user_id: "u_xxxxx",
            email: "user@example.com",
            avatar: "https://example.com/avatar.png",
            created_at: "2026-04-27T10:00:00Z",
          },
        },
      },
    );
    expect(JSON.stringify(consoleLogSpy.mock.calls)).not.toContain(fullToken);
    expect(JSON.stringify(consoleLogSpy.mock.calls)).not.toContain(fullZaiAccessToken);
  });

  it("logs zai token response request id on backend error", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    const consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const adapter = new ZaiProviderAdapter(
      {
        ...ZAI_OAUTH_PROVIDER_CONFIG,
        enabled: true,
      },
      createMockApiClient(fetchMock),
    );

    fetchMock.mockResolvedValueOnce(
      new Response("404 page not found", {
        status: 404,
        headers: {
          "Content-Type": "text/plain",
          "set-cookie": "visitor_id=secret",
          "x-request-id": "req-404",
          "x-span-id": "span-404",
          "x-trace-id": "trace-404",
        },
      }),
    );

    await expect(
      adapter.exchangeToken(
        { code: "authorization-code", state: "state-404" },
        {
          providerId: ZAI_PROVIDER_ID,
          state: "state-404",
          redirectUri: ZAI_OAUTH_PROVIDER_CONFIG.redirectUri,
          now: () => 1_800_000_000_000,
        },
      ),
    ).rejects.toEqual(
      expect.objectContaining<ApiError>({
        name: "ApiError",
        method: "POST",
        status: 404,
        url: ZAI_OAUTH_PROVIDER_CONFIG.tokenUrl,
      }),
    );

    expect(consoleLogSpy).toHaveBeenCalledWith(
      expect.stringContaining("[zaiOAuth]"),
      "token response error",
      {
        method: "POST",
        url: ZAI_OAUTH_PROVIDER_CONFIG.tokenUrl,
        status: 404,
        responseHeaders: {
          "x-request-id": "req-404",
          "x-span-id": "span-404",
          "x-trace-id": "trace-404",
        },
      },
    );
    expect(JSON.stringify(consoleLogSpy.mock.calls)).not.toContain("visitor_id=secret");
  });

  // Windows 机器上设置了 ZCODE_TEST_BASE_URL 等环境变量，会覆盖测试预期的 test 端点值

  it("keeps polling available when deep-link token exchange fails", async () => {
    let rejectExchange!: (error: Error) => void;
    const exchangeStarted = new Promise<never>((_, reject) => {
      rejectExchange = reject;
    });
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (url.endsWith("/api/v1/oauth/cli/init")) {
        return new Response(
          JSON.stringify({
            code: 0,
            data: {
              authorize_url: "https://example.com/authorize?state=flow-state",
              expires_at: 2_000_000_300,
              flow_id: "flow-1",
              poll_interval_sec: 1,
              poll_token: "poll-token",
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.endsWith("/api/v1/oauth/cli/poll/flow-1")) {
        return new Response(
          JSON.stringify({
            code: 0,
            data: {
              status: "ready",
              token: "poll-jwt",
              user: { user_id: "poll-user", name: "Poll User" },
              bigmodel: { access_token: "poll-provider-token" },
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    const service = new OAuthService(credentialServiceStub, {
      apiClient: createMockApiClient(fetchMock),
      adapters: [
        {
          providerId: BIGMODEL_PROVIDER_ID,
          meta: { id: BIGMODEL_PROVIDER_ID, displayName: "BigModel", enabled: true, order: 1 },
          redirectUri: DESKTOP_OAUTH_CALLBACK_URI,
          buildAuthorizeUrl: ({ state }) => `https://example.com/authorize?state=${state}`,
          parseCallbackParams: (url) => ({
            code: new URL(url).searchParams.get("code") ?? "",
            state: new URL(url).searchParams.get("state") ?? "",
          }),
          exchangeToken: async () => exchangeStarted,
          normalizePolledTokenSet: async ({ accessToken, zcodeJwtToken }) => ({
            accessToken,
            zcodeJwtToken,
          }),
          normalizeError: (error: unknown) => (error instanceof Error ? error : new Error(String(error))),
        },
      ],
      now: () => 2_000_000_000_000,
    });

    const started = await service.startOAuthWithPolling(BIGMODEL_PROVIDER_ID);
    const deepLink = service.handleCallback(
      `zcode://oauth/callback?state=${started.state}&code=deep-link-code`,
    );
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    rejectExchange(new Error("deep-link exchange failed"));
    await expect(deepLink).rejects.toThrow("deep-link exchange failed");

    await expect(service.pollPendingOAuth()).resolves.toEqual({
      kind: "session",
      provider: BIGMODEL_PROVIDER_ID,
      userInfo: { id: "poll-user", username: "Poll User", displayName: "Poll User" },
    });
    expect(await credentialServiceStub.load("oauth:bigmodel:access_token")).toBe(
      "poll-provider-token",
    );
  });

  it("does not persist a deep-link result after cancellation", async () => {
    let resolveExchange!: (tokenSet: OAuthTokenSet) => void;
    const exchange = new Promise<OAuthTokenSet>((resolve) => {
      resolveExchange = resolve;
    });
    const service = new OAuthService(credentialServiceStub, {
      adapters: [
        {
          providerId: BIGMODEL_PROVIDER_ID,
          meta: { id: BIGMODEL_PROVIDER_ID, displayName: "BigModel", enabled: true, order: 1 },
          redirectUri: DESKTOP_OAUTH_CALLBACK_URI,
          buildAuthorizeUrl: ({ state }) => `https://example.com/authorize?state=${state}`,
          parseCallbackParams: (url) => ({
            code: new URL(url).searchParams.get("code") ?? "",
            state: new URL(url).searchParams.get("state") ?? "",
          }),
          exchangeToken: async () => exchange,
          normalizeError: (error: unknown) => (error instanceof Error ? error : new Error(String(error))),
        },
      ],
    });
    const { state } = await service.startOAuth(BIGMODEL_PROVIDER_ID);
    const callback = service.handleCallback(`zcode://oauth/callback?state=${state}&code=late`);
    await Promise.resolve();
    await service.cancelPending();
    resolveExchange({ accessToken: "cancelled-token" });
    await expect(callback).resolves.toBeNull();
    expect(await credentialServiceStub.load("oauth:active_provider")).toBeNull();
    expect(await credentialServiceStub.load("zcodejwttoken")).toBeNull();
  });

  it("does not infer active provider from legacy token keys", async () => {
    const service = createBigModelService();

    await credentialServiceStub.save("auth_token", "legacy-token");

    await expect(service.getActiveProvider()).resolves.toBeNull();
    await expect(credentialServiceStub.load("oauth:active_provider")).resolves.toBeNull();
  });

  it("clears OAuth login credentials when active provider cannot be decrypted", async () => {
    const onProviderLogout = vi.fn(async () => {});
    const deletedKeys: string[] = [];
    const brokenCredentialService: ICredentialService = {
      load: async (key: string) => {
        if (key === "oauth:active_provider") {
          throw createMockCredentialDecryptError();
        }
        return `${key}-value`;
      },
      save: async () => {},
      delete: async (key: string) => {
        deletedKeys.push(key);
      },
    };
    const service = new OAuthService(brokenCredentialService, {
      adapters: [],
      onProviderLogout,
    });

    await expect(service.getActiveProvider()).resolves.toBeNull();

    expectDeletedOAuthSessionCredentials(deletedKeys);
    expectProviderLogoutNotifications(onProviderLogout, [BIGMODEL_PROVIDER_ID, ZAI_PROVIDER_ID]);
  });

  it("keeps corrupt OAuth recovery successful when derived provider cleanup fails", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const onProviderLogout = vi.fn(async () => {
      throw new Error("model provider config write failed");
    });
    const deletedKeys: string[] = [];
    const brokenCredentialService: ICredentialService = {
      load: async (key: string) => {
        if (key === "oauth:active_provider") {
          throw createMockCredentialDecryptError();
        }
        return `${key}-value`;
      },
      save: async () => {},
      delete: async (key: string) => {
        deletedKeys.push(key);
      },
    };
    const service = new OAuthService(brokenCredentialService, {
      adapters: [],
      onProviderLogout,
    });

    await expect(service.getActiveProvider()).resolves.toBeNull();

    expectDeletedOAuthSessionCredentials(deletedKeys);
    expectProviderLogoutNotifications(onProviderLogout, [BIGMODEL_PROVIDER_ID, ZAI_PROVIDER_ID]);
    expect(warnSpy).toHaveBeenCalled();
  });

  it("clears OAuth login credentials when cached user info cannot be decrypted", async () => {
    const onProviderLogout = vi.fn(async () => {});
    const deletedKeys: string[] = [];
    const brokenCredentialService: ICredentialService = {
      load: async (key: string) => {
        if (key === "oauth:active_provider") {
          return ZAI_PROVIDER_ID;
        }
        if (key === "oauth:zai:user_info") {
          throw createMockCredentialDecryptError();
        }
        return `${key}-value`;
      },
      save: async () => {},
      delete: async (key: string) => {
        deletedKeys.push(key);
      },
    };
    const service = new OAuthService(brokenCredentialService, {
      adapters: [
        {
          providerId: ZAI_PROVIDER_ID,
          meta: {
            id: ZAI_PROVIDER_ID,
            displayName: "Z.ai",
            enabled: true,
            order: 1,
          },
          redirectUri: DESKTOP_OAUTH_CALLBACK_URI,
          parseCallbackParams: () => ({ code: "", state: "" }),
          buildAuthorizeUrl: () => "https://example.com/auth",
          exchangeToken: async () => ({ accessToken: "unused" }),
          normalizeError: (error: unknown) =>
            error instanceof Error ? error : new Error(String(error)),
        },
      ],
      onProviderLogout,
    });

    await expect(service.restoreCachedSession()).resolves.toBeNull();

    expectDeletedOAuthSessionCredentials(deletedKeys);
    expectProviderLogoutNotifications(onProviderLogout, [BIGMODEL_PROVIDER_ID, ZAI_PROVIDER_ID]);
  });

  it("clears registered OAuth provider credentials when cached user info cannot be decrypted", async () => {
    const customProviderId = "custom-oauth" as OAuthProviderId;
    const onProviderLogout = vi.fn(async () => {});
    const deletedKeys: string[] = [];
    const brokenCredentialService: ICredentialService = {
      load: async (key: string) => {
        if (key === "oauth:active_provider") {
          return customProviderId;
        }
        if (key === `oauth:${customProviderId}:user_info`) {
          throw createMockCredentialDecryptError();
        }
        return `${key}-value`;
      },
      save: async () => {},
      delete: async (key: string) => {
        deletedKeys.push(key);
      },
    };
    const service = new OAuthService(brokenCredentialService, {
      adapters: [
        {
          providerId: customProviderId,
          meta: {
            id: customProviderId,
            displayName: "Custom OAuth",
            enabled: true,
            order: 9,
          },
          redirectUri: "zcode://custom-auth/callback",
          parseCallbackParams: () => ({ code: "", state: "" }),
          buildAuthorizeUrl: () => "https://example.com/auth",
          exchangeToken: async () => ({ accessToken: "unused" }),
          normalizeError: (error: unknown) =>
            error instanceof Error ? error : new Error(String(error)),
        },
      ],
      onProviderLogout,
    });

    await expect(service.restoreCachedSession()).resolves.toBeNull();

    expectDeletedOAuthSessionCredentials(deletedKeys, [
      `oauth:${customProviderId}:access_token`,
      `oauth:${customProviderId}:refresh_token`,
      `oauth:${customProviderId}:user_info`,
    ]);
    expectProviderLogoutNotifications(onProviderLogout, [
      BIGMODEL_PROVIDER_ID,
      ZAI_PROVIDER_ID,
      customProviderId,
    ]);
  });

  it("refresh only reads namespaced keys and ignores legacy keys", async () => {
    const refreshAdapter: OAuthProviderAdapter = {
      providerId: BIGMODEL_PROVIDER_ID,
      meta: {
        id: BIGMODEL_PROVIDER_ID,
        displayName: "BigModel",
        enabled: true,
        order: 0,
      },
      redirectUri: DESKTOP_OAUTH_CALLBACK_URI,
      parseCallbackParams: () => ({ code: "", state: "" }),
      buildAuthorizeUrl: () => "https://example.com/auth",
      exchangeToken: async () => ({ accessToken: "unused" }),
      refreshToken: async (tokenSet: OAuthTokenSet) => ({
        accessToken: `${tokenSet.accessToken}-refreshed`,
        refreshToken: tokenSet.refreshToken,
      }),
      fetchUserInfo: async (): Promise<OAuthUserProfile> => ({
        id: "u-1",
        username: "tester",
        displayName: "Tester",
      }),
      normalizeError: (error: unknown) =>
        error instanceof Error ? error : new Error(String(error)),
    };

    const service = createBigModelService({ adapters: [refreshAdapter] });

    await credentialServiceStub.save("oauth:active_provider", BIGMODEL_PROVIDER_ID);
    await credentialServiceStub.save("auth_token", "legacy-access");
    await credentialServiceStub.save("refresh_token", "legacy-refresh");

    await expect(service.refreshToken()).rejects.toThrow(/refresh_token/);

    expect(await credentialServiceStub.load("oauth:bigmodel:access_token")).toBeNull();
    expect(await credentialServiceStub.load("oauth:bigmodel:refresh_token")).toBeNull();
    expect(await credentialServiceStub.load("auth_token")).toBe("legacy-access");
    expect(await credentialServiceStub.load("refresh_token")).toBe("legacy-refresh");
  });

  it("returns null when restoring zai session without zcodejwttoken", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    const service = createBigModelService({
      apiClient: createMockApiClient(fetchMock),
    });

    await credentialServiceStub.save("oauth:active_provider", ZAI_PROVIDER_ID);
    await credentialServiceStub.save("oauth:zai:access_token", "zai-session-token");
    await credentialServiceStub.save(
      "oauth:zai:user_info",
      JSON.stringify({
        user_id: "zai-u-cached",
        email: "13800000000@phone.local",
        name: "旅行者0000",
      }),
    );

    await expect(service.restoreCachedSession()).resolves.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("restoreCachedSession returns null when cached user info is missing", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    const service = createBigModelService({
      apiClient: createMockApiClient(fetchMock),
    });

    await credentialServiceStub.save("oauth:active_provider", BIGMODEL_PROVIDER_ID);
    await credentialServiceStub.save("oauth:bigmodel:access_token", "session-access-token");

    await expect(service.restoreCachedSession()).resolves.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("app logout clears active provider credentials", async () => {
    const onProviderLogout = vi.fn(async () => {});
    const service = createBigModelService({ onProviderLogout });

    await credentialServiceStub.save("oauth:active_provider", ZAI_PROVIDER_ID);
    await credentialServiceStub.save("oauth:zai:access_token", "token");
    await credentialServiceStub.save("oauth:zai:refresh_token", "refresh");
    await credentialServiceStub.save(
      "oauth:zai:user_info",
      JSON.stringify({ user_id: "account-a", name: "Ada" }),
    );
    await credentialServiceStub.save("zcodejwttoken", "zai-jwt");
    await credentialServiceStub.save(
      "oauth:login_attribution",
      JSON.stringify({ channel_id: "google_ads" }),
    );

    await service.logout();

    expect(await credentialServiceStub.load("oauth:active_provider")).toBeNull();
    expect(await credentialServiceStub.load("oauth:zai:access_token")).toBeNull();
    expect(await credentialServiceStub.load("oauth:zai:refresh_token")).toBeNull();
    expect(await credentialServiceStub.load("oauth:zai:user_info")).toBeNull();
    expect(await credentialServiceStub.load("zcodejwttoken")).toBeNull();
    expect(await credentialServiceStub.load("oauth:login_attribution")).toBe(
      JSON.stringify({ channel_id: "google_ads" }),
    );
    expect(onProviderLogout).toHaveBeenCalledWith(ZAI_PROVIDER_ID, "account-a");
  });

  it("provider unlink logs out the matching active provider", async () => {
    const onProviderLogout = vi.fn(async () => {});
    const service = createBigModelService({ onProviderLogout });

    await credentialServiceStub.save("oauth:active_provider", BIGMODEL_PROVIDER_ID);
    await credentialServiceStub.save("oauth:bigmodel:access_token", "token");
    await credentialServiceStub.save("oauth:bigmodel:refresh_token", "refresh");
    await credentialServiceStub.save(
      "oauth:bigmodel:user_info",
      JSON.stringify({ id: "account-b", username: "Ada", displayName: "Ada" }),
    );
    await credentialServiceStub.save("zcodejwttoken", "bigmodel-jwt");

    await service.logout(BIGMODEL_PROVIDER_ID);

    expect(await credentialServiceStub.load("oauth:active_provider")).toBeNull();
    expect(await credentialServiceStub.load("oauth:bigmodel:access_token")).toBeNull();
    expect(await credentialServiceStub.load("oauth:bigmodel:refresh_token")).toBeNull();
    expect(await credentialServiceStub.load("oauth:bigmodel:user_info")).toBeNull();
    expect(await credentialServiceStub.load("zcodejwttoken")).toBeNull();
    expect(onProviderLogout).toHaveBeenCalledWith(BIGMODEL_PROVIDER_ID, "account-b");
  });

  it("provider unlink does not clear non-active provider credentials", async () => {
    const onProviderLogout = vi.fn(async () => {});
    const service = createBigModelService({ onProviderLogout });

    await credentialServiceStub.save("oauth:active_provider", ZAI_PROVIDER_ID);
    await credentialServiceStub.save("oauth:zai:access_token", "zai-token");
    await credentialServiceStub.save("oauth:bigmodel:access_token", "bigmodel-token");

    await service.logout(BIGMODEL_PROVIDER_ID);

    expect(await credentialServiceStub.load("oauth:active_provider")).toBe(ZAI_PROVIDER_ID);
    expect(await credentialServiceStub.load("oauth:zai:access_token")).toBe("zai-token");
    expect(await credentialServiceStub.load("oauth:bigmodel:access_token")).toBe("bigmodel-token");
    expect(onProviderLogout).not.toHaveBeenCalled();
  });

  // [leo] LeoBot 不接入官方 Z.ai / BigModel 账号:运行时配置没有任何 OAuth provider
  // (src/oauth/runtimeConfig.ts)。原先覆盖官方 polling / token 交换 / profile 迁移的用例已删除,
  // 这里只断言 Leo 行为:无登录入口、发起官方登录直接拒绝、旧的官方会话在 restore 时被清掉。
  it("Leo 默认不注册官方 OAuth provider，旧官方会话在 restore 时清除", async () => {
    const service = createBigModelService();

    await expect(service.getProviders()).resolves.toEqual([]);
    await expect(service.startOAuth(ZAI_PROVIDER_ID)).rejects.toThrow(
      "不支持的 OAuth provider: zai",
    );
    await expect(service.startOAuth(BIGMODEL_PROVIDER_ID)).rejects.toThrow(
      "不支持的 OAuth provider: bigmodel",
    );

    await credentialServiceStub.save("oauth:active_provider", BIGMODEL_PROVIDER_ID);
    await credentialServiceStub.save("oauth:bigmodel:access_token", "legacy-token");
    await credentialServiceStub.save(
      "oauth:bigmodel:user_info",
      JSON.stringify({ id: "u-1", username: "Ada", displayName: "Ada" }),
    );

    await expect(service.restoreCachedSession()).resolves.toBeNull();
    expect(await credentialServiceStub.load("oauth:active_provider")).toBeNull();
  });
});
