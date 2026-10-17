import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { HttpClientPort, HttpClientRequest, HttpClientResponse } from "@zcode/contracts";
import {
  SHARED_ZCODE_CREDENTIAL_KEYS,
  createSharedZCodeCredentialStore,
} from "@zcode/adapters/auth";
import { BUILTIN_MODEL_PROVIDER_IDS } from "@zcode/shared";
import {
  standaloneAccountIdentityCredentialKey,
  standaloneAccountAuthSourceCredentialKey,
  standaloneAccountProviderCredentialKey,
} from "../src/app/standalone-account-provider-runtime.js";
import {
  configureCodingPlanApiKey,
  hasConfiguredStandaloneCodingPlan,
  loginZCodeCli,
  logoutZCodeCli,
} from "../src/auth-login.js";

const TEST_ENV = {
  ZCODE_CREDENTIAL_SECRET: "bootstrap-test-secret",
  ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: fileURLToPath(
    new URL("../../../../../config/provider/zcode-builtin.json", import.meta.url),
  ),
};

describe("ZCode CLI login", () => {
  it("没有任何 Standalone 账号凭据时不会误报已配置 Coding Plan", async () => {
    const dir = await mkdtemp(join(tmpdir(), "zcode-no-login-"));
    const credentialStore = createSharedZCodeCredentialStore({
      baseDir: dir,
      env: TEST_ENV,
    });
    try {
      await expect(
        hasConfiguredStandaloneCodingPlan({ credentialStore, env: TEST_ENV }),
      ).resolves.toBe(false);
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  // [leo] Z.ai / BigModel 平台账号 OAuth 登录在 LeoBot 中被移除：createCliOAuthClient 在发出任何
  // 请求、打开浏览器之前直接失败（packages/adapters/src/auth/cli-oauth.ts）。上游 OAuth init/poll/
  // 失败重试/取消四个用例全部依赖真实 OAuth 流程，改为断言 Leo 的禁用行为。
  it("rejects ZAI OAuth login before any request or browser open", async () => {
    const dir = await mkdtemp(join(tmpdir(), "zcode-login-disabled-"));
    const credentialStore = createSharedZCodeCredentialStore({ baseDir: dir, env: TEST_ENV });
    const httpClient = new FakeHttpClient([]);
    let authorizeUrlSeen = false;
    try {
      await expect(
        loginZCodeCli({
          credentialStore,
          env: TEST_ENV,
          httpClient,
          noBrowser: true,
          onAuthorizeUrl: () => {
            authorizeUrlSeen = true;
          },
          pollToken: "poll-token",
          sleep: async () => undefined,
        }),
      ).rejects.toMatchObject({
        name: "CliOAuthError",
        message: expect.stringContaining("account login is disabled in LeoBot"),
      });
      expect(httpClient.requests).toHaveLength(0);
      expect(authorizeUrlSeen).toBe(false);
      expect(await credentialStore.load(SHARED_ZCODE_CREDENTIAL_KEYS.zaiAccessToken)).toBeNull();
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  it("clears shared ZAI credentials and standalone account access on logout", async () => {
    const dir = await mkdtemp(join(tmpdir(), "zcode-logout-"));
    const credentialStore = createSharedZCodeCredentialStore({
      baseDir: dir,
      env: TEST_ENV,
    });

    try {
      await credentialStore.saveZaiLoginCredentials({
        accessToken: "zai-access-token",
        jwtToken: "jwt-token",
        user: {
          user_id: "u_1",
        },
      });
      const accountProviderCredentialKey = standaloneAccountProviderCredentialKey({
        providerId: BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan,
        accountIdentity: "u_1",
      });
      await credentialStore.saveMany({
        [standaloneAccountIdentityCredentialKey(
          BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan,
        )]: "u_1",
        [standaloneAccountAuthSourceCredentialKey(
          BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan,
        )]: "manual",
        [accountProviderCredentialKey]: "coding-plan-key",
      });

      const result = await logoutZCodeCli({ credentialStore, env: TEST_ENV });

      expect(result.credentialsPath).toBe(credentialStore.filePath);
      expect(await credentialStore.load(SHARED_ZCODE_CREDENTIAL_KEYS.zaiAccessToken)).toBeNull();
      expect(await credentialStore.load(SHARED_ZCODE_CREDENTIAL_KEYS.activeProvider)).toBeNull();
      expect(
        await credentialStore.load(
          standaloneAccountIdentityCredentialKey(
            BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan,
          ),
        ),
      ).toBeNull();
      expect(await credentialStore.load(accountProviderCredentialKey)).toBeNull();
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  it.each(["oauth", undefined])("退出不解密来源为 %s 的历史旧 Key", async (source) => {
    const dir = await mkdtemp(join(tmpdir(), "zcode-logout-legacy-"));
    const credentialStore = createSharedZCodeCredentialStore({ baseDir: dir, env: TEST_ENV });
    const providerId = BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan;
    const legacyKey = standaloneAccountProviderCredentialKey({
      providerId,
      accountIdentity: "user",
    });
    try {
      await credentialStore.saveMany({
        [SHARED_ZCODE_CREDENTIAL_KEYS.zaiAccessToken]: "valid-oauth",
        [standaloneAccountIdentityCredentialKey(providerId)]: "user",
        ...(source ? { [standaloneAccountAuthSourceCredentialKey(providerId)]: source } : {}),
      });
      const raw = JSON.parse(await readFile(credentialStore.filePath, "utf8"));
      raw[legacyKey] = "enc:v1:broken-legacy-key";
      await writeFile(credentialStore.filePath, JSON.stringify(raw));
      await expect(logoutZCodeCli({ credentialStore, env: TEST_ENV })).resolves.toMatchObject({
        credentialsPath: credentialStore.filePath,
      });
      expect(await credentialStore.load(SHARED_ZCODE_CREDENTIAL_KEYS.zaiAccessToken)).toBeNull();
      expect(
        await credentialStore.load(standaloneAccountIdentityCredentialKey(providerId)),
      ).toBeNull();
      expect(JSON.parse(await readFile(credentialStore.filePath, "utf8"))[legacyKey]).toBe(
        raw[legacyKey],
      );
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  it("manual Coding Plan API Key uses the same Account Access and Selection facts", async () => {
    const dir = await mkdtemp(join(tmpdir(), "zcode-api-key-login-"));
    const credentialStore = createSharedZCodeCredentialStore({
      baseDir: join(dir, "home"),
      env: TEST_ENV,
    });
    const personalProviderConfigPath = join(dir, "provider_config.json");
    const zcodeBuiltinProviderConfigPath = join(dir, "zcode-builtin.json");
    const configuredProviderId = "configured-bigmodel-individual";
    await writeFile(
      zcodeBuiltinProviderConfigPath,
      JSON.stringify({
        schemaVersion: 1,
        revision: 1,
        config: {
          providerConfigRules: {
            templateRules: [],
            providerRules: [
              {
                providerId: configuredProviderId,
                config: {
                  group: "bigmodel-family",
                  builtinModelIds: ["model-from-config"],
                  access: {
                    type: "zhipu-account",
                    accountType: "bigmodel",
                    mode: "individual-coding-plan",
                  },
                },
              },
            ],
          },
          modelConfigRules: {
            modelRules: [],
            modelApiRules: [],
            providerSiteRules: [],
            templateModelRules: [],
            builtinProviderModelRules: [],
          },
        },
      }),
    );

    try {
      const result = await configureCodingPlanApiKey({
        apiKey: "manual-key",
        credentialStore,
        env: {
          ...TEST_ENV,
          ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: zcodeBuiltinProviderConfigPath,
        },
        personalProviderConfigPath,
        providerId: "bigmodel",
      });

      expect(result).toEqual({
        configPath: personalProviderConfigPath,
        model: `${configuredProviderId}/model-from-config`,
        providerId: "bigmodel",
      });
      await expect(
        hasConfiguredStandaloneCodingPlan({
          credentialStore,
          env: {
            ...TEST_ENV,
            ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: zcodeBuiltinProviderConfigPath,
          },
        }),
      ).resolves.toBe(true);
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });
});

class FakeHttpClient implements HttpClientPort {
  readonly requests: HttpClientRequest[] = [];

  constructor(private readonly responses: HttpClientResponse[]) {}

  async request(request: HttpClientRequest): Promise<HttpClientResponse> {
    this.requests.push(request);
    const response = this.responses.shift();
    if (!response) {
      throw new Error("No fake response configured");
    }
    return response;
  }
}
