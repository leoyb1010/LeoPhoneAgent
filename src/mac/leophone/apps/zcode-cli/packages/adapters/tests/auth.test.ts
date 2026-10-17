import { fork } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HttpClientPort, HttpClientRequest, HttpClientResponse } from "@zcode/contracts";
import {
  CliOAuthError,
  SHARED_ZCODE_CREDENTIAL_KEYS,
  createBigmodelOAuthClient,
  createCliOAuthClient,
  createCodingPlanApiKeyResolver,
  createSharedZCodeCredentialStore,
  loadSharedZCodeCredentialSync,
} from "../src/auth/index.js";

const TEST_ENV = {
  ZCODE_CREDENTIAL_SECRET: "test-secret",
};

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("shared ZCode credentials", () => {
  it("stores ZAI login credentials with z-code compatible encrypted keys", async () => {
    const dir = await mkdtemp(join(tmpdir(), "zcode-auth-"));

    try {
      const store = createSharedZCodeCredentialStore({
        baseDir: dir,
        env: TEST_ENV,
      });

      await store.saveZaiLoginCredentials({
        accessToken: "zai-access-token",
        jwtToken: "zcode-jwt-token",
        user: {
          email: "alice@example.com",
          name: "Alice",
          user_id: "u_1",
        },
      });

      const raw = JSON.parse(await readFile(store.filePath, "utf-8")) as Record<string, string>;
      // [leo] 共享凭据只在 ~/.leophoneagent/v2/credentials.json，不读写官方 ~/.zcode。
      expect(store.filePath).toBe(join(dir, ".leophoneagent", "v2", "credentials.json"));
      expect(raw[SHARED_ZCODE_CREDENTIAL_KEYS.zaiAccessToken]?.startsWith("enc:v1:")).toBe(true);
      expect(await store.load(SHARED_ZCODE_CREDENTIAL_KEYS.activeProvider)).toBe("zai");
      expect(await store.load(SHARED_ZCODE_CREDENTIAL_KEYS.zaiAccessToken)).toBe(
        "zai-access-token",
      );
      expect(await store.load(SHARED_ZCODE_CREDENTIAL_KEYS.zcodeJwtToken)).toBe("zcode-jwt-token");
      expect(
        loadSharedZCodeCredentialSync(SHARED_ZCODE_CREDENTIAL_KEYS.zaiAccessToken, {
          baseDir: dir,
          env: TEST_ENV,
        }),
      ).toBe("zai-access-token");
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  it("reads legacy plaintext credential values", async () => {
    const dir = await mkdtemp(join(tmpdir(), "zcode-auth-"));
    const credentialsDir = join(dir, ".leophoneagent", "v2"); // [leo] 数据根 ~/.leophoneagent
    const credentialsPath = join(credentialsDir, "credentials.json");

    try {
      await mkdir(credentialsDir, { recursive: true });
      await writeFile(
        credentialsPath,
        JSON.stringify({
          [SHARED_ZCODE_CREDENTIAL_KEYS.zaiAccessToken]: "legacy-token",
        }),
      );

      const store = createSharedZCodeCredentialStore({
        baseDir: dir,
        env: TEST_ENV,
      });

      expect(await store.load(SHARED_ZCODE_CREDENTIAL_KEYS.zaiAccessToken)).toBe("legacy-token");
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  it("preserves every key across concurrent read-modify-write mutations", async () => {
    const dir = await mkdtemp(join(tmpdir(), "zcode-auth-concurrent-"));
    const store = createSharedZCodeCredentialStore({
      baseDir: dir,
      env: TEST_ENV,
    });
    const entries = Array.from({ length: 40 }, (_, index) => [`key-${index}`, `value-${index}`]);

    try {
      await Promise.all(entries.map(([key, value]) => store.save(key!, value!)));

      await Promise.all(
        entries.map(async ([key, value]) => {
          await expect(store.load(key!)).resolves.toBe(value);
        }),
      );
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  it("deletes a credential only when its expected plaintext value is still current", async () => {
    const dir = await mkdtemp(join(tmpdir(), "zcode-auth-compare-delete-"));
    const store = createSharedZCodeCredentialStore({
      baseDir: dir,
      env: TEST_ENV,
    });

    try {
      await store.save("oauth:snapshot", "snapshot-a");

      await expect(store.deleteIfValue("oauth:snapshot", "stale-snapshot")).resolves.toBe(false);
      await expect(store.load("oauth:snapshot")).resolves.toBe("snapshot-a");
      await expect(store.deleteIfValue("oauth:snapshot", "snapshot-a")).resolves.toBe(true);
      await expect(store.load("oauth:snapshot")).resolves.toBeNull();
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  it("publishes a replacement credential and removes legacy keys in one mutation", async () => {
    const dir = await mkdtemp(join(tmpdir(), "zcode-auth-replace-"));
    const store = createSharedZCodeCredentialStore({
      baseDir: dir,
      env: TEST_ENV,
    });

    try {
      await store.save("oauth:legacy-client", "client-a");
      await store.save("oauth:legacy-tokens", "tokens-a");

      await store.saveReplacing("oauth:canonical", "pair-a", [
        "oauth:legacy-client",
        "oauth:legacy-tokens",
      ]);

      await expect(store.load("oauth:canonical")).resolves.toBe("pair-a");
      await expect(store.load("oauth:legacy-client")).resolves.toBeNull();
      await expect(store.load("oauth:legacy-tokens")).resolves.toBeNull();
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  it("preserves every key across independent Node processes", async () => {
    const dir = await mkdtemp(join(tmpdir(), "zcode-auth-processes-"));
    const credentialsPath = join(dir, "credentials.json");
    const processCount = 4;
    const keysPerProcess = 8;

    try {
      await runConcurrentCredentialWorkers(credentialsPath, processCount, keysPerProcess);
      const store = createSharedZCodeCredentialStore({
        env: TEST_ENV,
        filePath: credentialsPath,
      });
      await Promise.all(
        Array.from({ length: processCount }, (_, processIndex) =>
          Array.from({ length: keysPerProcess }, async (_, keyIndex) => {
            await expect(store.load(`worker-${processIndex}:key-${keyIndex}`)).resolves.toBe(
              `value-${processIndex}-${keyIndex}`,
            );
          }),
        ).flat(),
      );
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  }, 15_000);

  it("backs up corrupt JSON and refuses to overwrite it", async () => {
    const dir = await mkdtemp(join(tmpdir(), "zcode-auth-corrupt-"));
    const credentialsPath = join(dir, "credentials.json");
    const store = createSharedZCodeCredentialStore({
      env: TEST_ENV,
      filePath: credentialsPath,
    });

    try {
      await writeFile(credentialsPath, "{not-json", {
        encoding: "utf-8",
        mode: 0o644,
      });

      await Promise.all(
        Array.from({ length: 8 }, () =>
          expect(store.load("safe-key")).rejects.toThrow("Shared ZCode credentials are corrupt"),
        ),
      );
      await expect(store.save("safe-key", "safe-value")).rejects.toThrow(
        "Shared ZCode credentials are corrupt",
      );
      await expect(readFile(credentialsPath, "utf-8")).resolves.toBe("{not-json");
      const backups = (await readdir(dir)).filter((file) =>
        /^credentials\.json\.corrupt-.*\.bak$/.test(file),
      );
      expect(backups).toHaveLength(1);
      await expect(readFile(join(dir, backups[0]!), "utf-8")).resolves.toBe("{not-json");
      if (process.platform !== "win32") {
        expect((await stat(join(dir, backups[0]!))).mode & 0o777).toBe(0o600);
      }
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  it("deduplicates corrupt credential backups across independent Node processes", async () => {
    const dir = await mkdtemp(join(tmpdir(), "zcode-auth-corrupt-processes-"));
    const credentialsPath = join(dir, "credentials.json");

    try {
      await writeFile(credentialsPath, "{not-json", "utf-8");
      await runConcurrentCredentialWorkers(credentialsPath, 6, 0, "read-corrupt");

      const backups = (await readdir(dir)).filter((file) =>
        /^credentials\.json\.corrupt-.*\.bak$/.test(file),
      );
      expect(backups).toHaveLength(1);
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });
});

async function runConcurrentCredentialWorkers(
  filePath: string,
  processCount: number,
  keysPerProcess: number,
  operation: "save" | "read-corrupt" = "save",
): Promise<void> {
  const workerUrl = new URL("./fixtures/shared-credentials-concurrent-process.ts", import.meta.url);
  const children = Array.from({ length: processCount }, (_, processIndex) =>
    fork(workerUrl, {
      env: { ...process.env, NODE_NO_WARNINGS: "1" },
      execArgv: ["--import", "tsx"],
      stdio: ["ignore", "ignore", "inherit", "ipc"],
    }),
  );

  try {
    await Promise.all(
      children.map(
        (child) =>
          new Promise<void>((resolve, reject) => {
            child.once("error", reject);
            child.once("exit", (code) =>
              reject(new Error(`credential child exited early: ${code}`)),
            );
            child.on("message", (message: { type?: unknown }) => {
              if (message.type === "ready") resolve();
            });
          }),
      ),
    );

    const results = children.map(
      (child) =>
        new Promise<void>((resolve, reject) => {
          child.once("error", reject);
          child.once("exit", (code) => {
            if (code !== 0) reject(new Error(`credential child exited with code ${code}`));
          });
          child.on("message", (message: { error?: unknown; type?: unknown }) => {
            if (message.type === "done") resolve();
            if (message.type === "error") reject(new Error(String(message.error)));
          });
        }),
    );

    children.forEach((child, processIndex) => {
      child.send({
        filePath,
        keysPerProcess,
        operation,
        processIndex,
        type: "start",
      });
    });
    await Promise.all(results);
  } finally {
    for (const child of children) {
      if (child.connected) child.disconnect();
      child.kill();
    }
  }
}

// CLI 浏览器登录的轮询客户端按 providerId 泛化（zai/bigmodel），ready 数据统一为 accessToken。
// [leo] LeoBot 不再支持 Z.ai / BigModel 平台账号登录与 Coding Plan 项目令牌换取：
// 上游这些用例针对官方 OAuth / biz 接口的成功路径，Leo 改为断言在发出任何请求之前就失败。
describe("CLI OAuth client", () => {
  it.each(["zai", "bigmodel"] as const)("refuses to create a %s CLI OAuth client", (providerId) => {
    const httpClient = new FakeHttpClient([jsonResponse({ code: 0, msg: "", data: {} })]);

    expect(() => createCliOAuthClient({ httpClient, providerId })).toThrow(CliOAuthError);
    expect(() => createCliOAuthClient({ httpClient, providerId })).toThrow(
      /account login is disabled in LeoBot/,
    );
    expect(httpClient.requests).toHaveLength(0);
  });
});

describe("Coding Plan API key resolver", () => {
  it.each(["bigmodel", "zai"] as const)(
    "fails %s project token resolution without any network request",
    async (family) => {
      const httpClient = new FakeHttpClient([
        jsonResponse({ code: 200, data: { access_token: "biz-token" } }),
        customerInfoResponse(),
        jsonResponse({ code: 200, data: [{ apiKey: "key", name: "zcode-api-key" }] }),
        jsonResponse({
          code: 200,
          data: {
            accessToken: "project-token",
            tokenType: "Bearer",
            expiresIn: 600,
            expiresAt: Math.floor(Date.now() / 1000) + 600,
          },
        }),
      ]);
      const resolver = createCodingPlanApiKeyResolver({ httpClient });

      await expect(resolver.resolve({ accessToken: "login-token", family })).rejects.toThrow(
        /^project_token_/,
      );
      await expect(
        resolver.resolveMaterial({ accessToken: "login-token", family }),
      ).rejects.toThrow(/^project_token_/);
      expect(httpClient.requests).toHaveLength(0);
    },
  );
});

describe("BigModel OAuth client", () => {
  it("refuses to create a BigModel OAuth client", () => {
    const httpClient = new FakeHttpClient([]);

    expect(() => createBigmodelOAuthClient({ appSecret: "test-secret", httpClient })).toThrow(
      expect.objectContaining({
        name: "BigmodelOAuthError",
        message: "BigModel account login is disabled in LeoBot.",
      }),
    );
    expect(httpClient.requests).toHaveLength(0);
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

function jsonResponse(body: unknown, status = 200): HttpClientResponse {
  const encoded = new TextEncoder().encode(JSON.stringify(body));
  return {
    body: encoded,
    bytes: encoded.byteLength,
    durationMs: 1,
    headers: {
      "content-type": "application/json",
    },
    status,
    statusText: status === 200 ? "OK" : "Error",
    url: "https://zcode.example/api/v1",
  };
}

function customerInfoResponse(): HttpClientResponse {
  return jsonResponse({
    code: 200,
    data: {
      organizations: [
        {
          organizationId: "org-1",
          organizationName: "默认机构",
          projects: [
            {
              projectId: "project-1",
              projectName: "默认项目",
            },
          ],
        },
      ],
    },
  });
}
