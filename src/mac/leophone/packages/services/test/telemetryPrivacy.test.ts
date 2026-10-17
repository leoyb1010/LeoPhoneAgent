import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { once } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTelemetryCore } from "#src/telemetry/telemetryCore.js";

// [leo] LeoPhoneAgent 不向官方上报遥测：ZCODE_TELEMETRY_REPORT_ENDPOINT 恒为 ""。
// 最强的隐私边界是"任何事件都不出网"，这里把上游"出网 payload 已脱敏"的断言改为"根本不出网"。
// 上游"仅发送登录 hostname"的 payload 用例随上报一并移除（字段清洗本身在 shared 侧覆盖）。

const homes: string[] = [];
afterEach(async () => {
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

describe("TelemetryCore final HTTP privacy boundary", () => {
  it("[leo] 本机 HTTP 接收器收不到任何 telemetry 请求，即使注入了 endpoint origin", async () => {
    const received: string[] = [];
    const server = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      received.push(Buffer.concat(chunks).toString("utf8"));
      response.writeHead(204).end();
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Missing test server port");
      const homeDir = await mkdtemp(join(tmpdir(), "telemetry-privacy-http-"));
      homes.push(homeDir);
      const core = createTelemetryCore({
        homeDir,
        resolveZCodeEndpointOrigin: () => `http://127.0.0.1:${address.port}`,
      });
      const context = { clientTimezone: "UTC", clientLanguage: "en-US", screenResolution: "1x1" };
      await core.reportEvent({
        context,
        elementName: "app_login_ck",
        eventRegion: "app",
        eventType: "ck",
        eventExtraDetail: {
          login_url: "https://login.example.com/auth?state=FAKE_STATE&token=FAKE_TOKEN",
        },
      });
      await core.reportEvent({
        context,
        elementName: "message_completion",
        eventRegion: "app",
        eventType: "agent_trace",
        eventExtraDetail: {
          error_msg: "Authorization: Bearer FAKE_TOKEN /Users/FAKE_USER/private",
          error_type: "TOOL_EXEC_ERROR",
        },
      });
      await core.reportAppLaunch(context);
      await core.flushPendingReports({ timeoutMs: 100 });
      expect(received).toEqual([]);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });

  it.each(["agent_step", "message_completion", "automation_create_result", "future_event"])(
    "[leo] 直接 Core 调用 %s 不出网、不读取鉴权",
    async (elementName) => {
      const homeDir = await mkdtemp(join(tmpdir(), "telemetry-privacy-"));
      homes.push(homeDir);
      const fetchImpl = vi
        .fn<typeof fetch>()
        .mockResolvedValue(new Response(null, { status: 204 }));
      const loadAuthorization = vi.fn(async () => "Bearer FAKE_AUTH_HEADER");
      const core = createTelemetryCore({
        homeDir,
        fetchImpl,
        sleep: async () => {},
        loadAuthorization,
      });
      await core.reportEvent({
        context: { clientTimezone: "UTC", clientLanguage: "en-US", screenResolution: "1x1" },
        elementName,
        eventRegion: "app",
        eventType: "result",
        eventExtraDetail: {
          error_msg: "FAKE_BODY_SECRET https://example.com/private /Users/private/key",
          error_code: "E_TEST",
        },
      });
      expect(fetchImpl).not.toHaveBeenCalled();
      expect(loadAuthorization).not.toHaveBeenCalled();
    },
  );
});
