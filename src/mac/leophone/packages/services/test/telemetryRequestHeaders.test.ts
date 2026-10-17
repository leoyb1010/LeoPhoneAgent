import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createTelemetryCore } from "../src/telemetry/telemetryCore.js";
import { createTelemetryAuthorizationLoader } from "../src/node.js";

const homes: string[] = [];
afterEach(async () => {
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});
const context = {
  clientLanguage: "zh-CN",
  clientTimezone: "Asia/Shanghai",
  screenResolution: "100x100",
};

// [leo] ZCODE_TELEMETRY_REPORT_ENDPOINT 恒为 ""：即使注入了 endpoint origin，上报也不出网，
// 因而不会构造公共头、也不会读取 JWT。上游断言请求头/重试重读鉴权的用例改为断言不触网。
it("[leo] never sends telemetry or reads authorization, even with an injected endpoint", async () => {
  const homeDir = await mkdtemp(join(tmpdir(), "telemetry-headers-"));
  homes.push(homeDir);
  const loadAuthorization = vi.fn(async () => "Bearer first");
  const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 204 }));
  const core = createTelemetryCore({
    homeDir,
    fetchImpl,
    loadAuthorization,
    loadUserId: async () => "user-1",
    randomUUID: () => "device-1",
    resolveZCodeEndpointOrigin: () => "https://zcode.example.test",
  });
  await core.reportAppLaunch(context);
  await core.reportAppLaunch(context);
  expect(fetchImpl).not.toHaveBeenCalled();
  expect(loadAuthorization).not.toHaveBeenCalled();
});

it.each(["zai", "bigmodel"])(
  "only reads JWT for active %s, never OAuth/API keys",
  async (provider) => {
    const values: Record<string, string> = {
      "oauth:active_provider": provider,
      [`oauth:${provider}:user_info`]: '{"id":"u1"}',
      zcodejwttoken: "jwt-1",
    };
    const load = vi.fn(async (key: string) => values[key] ?? null);
    const authorization = createTelemetryAuthorizationLoader({ load });
    expect(await authorization("u1")).toBe("Bearer jwt-1");
    values.zcodejwttoken = "jwt-2";
    expect(await authorization("u1")).toBe("Bearer jwt-2");
    expect(await authorization("other-user")).toBeNull();
    delete values["oauth:active_provider"];
    expect(await authorization("u1")).toBeNull();
    expect(await authorization("")).toBeNull();
    expect(
      load.mock.calls.every(([key]) => !key.includes("access_token") && !key.includes("api_key")),
    ).toBe(true);
  },
);

it("drops JWT when the account changes during the read, and fails closed on errors", async () => {
  let provider = "bigmodel";
  const authorization = createTelemetryAuthorizationLoader({
    load: async (key) => {
      if (key === "oauth:active_provider") return provider;
      if (key.endsWith(":user_info")) return '{"user_id":"u1"}';
      provider = "zai";
      return "old-jwt";
    },
  });
  expect(await authorization("u1")).toBeNull();
  const failed = createTelemetryAuthorizationLoader({
    load: async () => {
      throw new Error("secret");
    },
  });
  expect(await failed("u1")).toBeNull();
});

it.each([null, "", "   ", "bad\r\nheader"])("omits absent or unsafe JWT: %j", async (token) => {
  const authorization = createTelemetryAuthorizationLoader({
    load: async (key) => {
      if (key === "oauth:active_provider") return "zai";
      if (key.endsWith(":user_info")) return '{"id":"u1"}';
      return token;
    },
  });
  expect(await authorization("u1")).toBeNull();
});
