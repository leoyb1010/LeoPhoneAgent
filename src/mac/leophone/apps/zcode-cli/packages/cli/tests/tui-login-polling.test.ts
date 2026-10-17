// [leo] LeoBot 禁用了 Z.ai / BigModel 平台账号 OAuth 登录（adapters/src/auth/cli-oauth.ts
// 在发出任何请求前直接抛 CliOAuthError）。上游的浏览器轮询 / 取消 / 超时 / 凭据落盘 / TUI 刷新模型
// 等用例只覆盖已删除的登录流程，已移除；这里改为断言登录在任何网络请求之前被拒绝、且不落盘任何凭据。
import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HttpClientPort } from "@zcode/contracts";
import {
  createSharedZCodeCredentialStore,
  SHARED_ZCODE_CREDENTIAL_KEYS as keys,
} from "@zcode/adapters/auth";
import {
  loginZCodeCli,
  loginBigmodelCodingPlan,
  type LoginZCodeCliOptions,
} from "../../bootstrap/src/auth-login.js";
import type { RunDependencies } from "../src/cli-types.js";
import { runLoginCommand } from "../src/login-command.js";

const authorizeUrl = "https://login.example.test/authorize?state=test-state";

async function fixture(t: TestContext, providerId: "zai" | "bigmodel") {
  const dir = await mkdtemp(join(tmpdir(), "zcode-login-test-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const env = {
    ZCODE_DATA_BASE_DIR: dir,
    ZCODE_CREDENTIAL_SECRET: "test-encryption-key",
  };
  const store = createSharedZCodeCredentialStore({ env });
  const requests: Parameters<HttpClientPort["request"]>[0][] = [];
  const opened: string[] = [];
  const httpClient: HttpClientPort = {
    async request(request) {
      requests.push(request);
      throw new Error("Leo login must not issue HTTP requests");
    },
  };
  const options: LoginZCodeCliOptions = {
    env,
    credentialStore: store,
    providerId,
    httpClient,
    pollToken: "test-private-poll-token",
    openBrowser: async (url: string) => {
      opened.push(url);
    },
    sleep: async () => {},
  } as LoginZCodeCliOptions;
  return { store, requests, opened, options };
}

for (const providerId of ["zai", "bigmodel"] as const) {
  test(`${providerId} account login is disabled before any request and persists nothing`, async (t) => {
    const f = await fixture(t, providerId);
    const login = providerId === "bigmodel" ? loginBigmodelCodingPlan : loginZCodeCli;
    await assert.rejects(login(f.options), {
      name: "CliOAuthError",
      message: /account login is disabled in LeoBot/,
    });
    assert.equal(f.requests.length, 0);
    assert.equal(f.opened.length, 0);
    assert.equal(await f.store.load(keys.zcodeJwtToken), null);
    assert.equal(await f.store.load(keys.activeProvider), null);
    assert.equal(await f.store.load(keys.bigmodelRefreshToken), null);
  });
}

test("standalone login accepts provider selection and keeps authorization URL out of JSON stdout", async () => {
  let stdout = "";
  let stderr = "";
  let selected = "";
  const deps = {
    env: {},
    cwd: () => process.cwd(),
    loadDotenv: () => ({ keys: [], loaded: false, path: "" }),
    loginZCodeCli: async (options: LoginZCodeCliOptions) => {
      selected = options.providerId!;
      assert.equal(options.noBrowser, true);
      await options.onAuthorizeUrl?.({
        authorize_url: authorizeUrl,
        expires_at: 12345,
        flow_id: "flow",
        poll_interval_sec: 1,
      });
      return {
        providerId: "bigmodel",
        user: { user_id: "test-account" },
        model: "provider/model",
        configPath: "test-config",
        credentialsPath: "test-credentials",
      };
    },
  } as unknown as RunDependencies;
  const context = {
    stdout: {
      write: (text: string) => {
        stdout += text;
      },
    },
    stderr: {
      write: (text: string) => {
        stderr += text;
      },
    },
  } as unknown as Parameters<typeof runLoginCommand>[0];
  const options = { json: true } as Parameters<typeof runLoginCommand>[1];
  assert.equal(await runLoginCommand(context, options, deps, true, ["bigmodel"]), 0);
  assert.equal(selected, "bigmodel");
  assert.equal(JSON.parse(stdout).provider, "bigmodel");
  assert.match(stderr, /login\.example\.test/);
  assert.doesNotMatch(stdout, /authorize/);
});
