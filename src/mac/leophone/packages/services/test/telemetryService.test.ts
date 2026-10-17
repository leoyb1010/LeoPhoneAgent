import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setDataBaseDir } from "../src/paths.js";

const originalHome = process.env.HOME;
const originalCrypto = globalThis.crypto;
const tempHomes: string[] = [];

function makeTempHome(): string {
  const home = mkdtempSync(join(tmpdir(), "zcode-telemetry-home-"));
  tempHomes.push(home);
  // Bugfix: paths.ts 会在模块加载时固定默认 dataBaseDir，测试隔离必须显式覆盖。
  setDataBaseDir(home);
  return home;
}

beforeEach(() => {
  Object.defineProperty(globalThis, "crypto", {
    value: originalCrypto,
    configurable: true,
  });
});

afterEach(() => {
  process.env.HOME = originalHome;
  setDataBaseDir(null);
  Object.defineProperty(globalThis, "crypto", {
    value: originalCrypto,
    configurable: true,
  });
  vi.restoreAllMocks();

  while (tempHomes.length > 0) {
    const home = tempHomes.pop();
    if (home) {
      rmSync(home, { recursive: true, force: true });
    }
  }
});

// [leo] LeoPhoneAgent 不向官方上报遥测：ZCODE_TELEMETRY_REPORT_ENDPOINT 恒为 ""，sendReport 直接返回。
// 上游断言出网 payload / 营销归因 / userId 注入 / 非 2xx 重试 / 并发 fetch 不阻塞的用例随出网上报移除；
// 仍是活代码的本地状态（telemetry-state.json 的 deviceMid、按本地日去重的 app_daily_active、
// 孤儿锁回收）改为直接断言落盘状态，状态目录是 ~/.leophoneagent/v2（不是 ~/.zcode/v2）。
const context = {
  clientTimezone: "Asia/Shanghai",
  clientLanguage: "zh-CN",
  screenResolution: "3024x1964",
};

function stateDirOf(home: string): string {
  return join(home, ".leophoneagent", "v2");
}

function readState(home: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(stateDirOf(home), "telemetry-state.json"), "utf-8"));
}

describe("telemetryCore", () => {
  it("exports a telemetry core factory", async () => {
    const loadModule = () => import("../src/telemetry/telemetryCore.js");

    await expect(loadModule()).resolves.toMatchObject({
      createTelemetryCore: expect.any(Function),
    });
  });

  it("[leo] never sends any report, loads no attribution/authorization and writes no logs", async () => {
    const home = makeTempHome();
    const { createTelemetryCore } = await import("../src/telemetry/telemetryCore.js");
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 204 }));
    const loadMarketingParams = vi.fn(async () => ({ channel_id: "douyin" }));
    const loadAuthorization = vi.fn(async () => "Bearer secret");
    const warn = vi.fn();
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const service = createTelemetryCore({
      homeDir: home,
      fetchImpl: fetchMock,
      loadUserId: async () => "60171703486074334",
      loadMarketingParams,
      loadAuthorization,
      warn,
      resolveZCodeEndpointOrigin: () => "https://zcode.example.test",
      now: () => Date.UTC(2026, 3, 2, 10, 0, 0),
    });

    await service.reportAppLaunch(context);
    await service.reportAppDailyActive(context);
    await service.reportEvent({
      context,
      elementName: "send_btn",
      eventRegion: "app",
      eventType: "ck",
      eventExtraDetail: { input_send_time: "1710000000200" },
      talkId: "task-001",
      messageId: "message-001",
    });
    await service.flushPendingReports({ timeoutMs: 100 });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(loadMarketingParams).not.toHaveBeenCalled();
    expect(loadAuthorization).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    expect(consoleSpy).not.toHaveBeenCalled();
  });

  it("records app_daily_active at most once per client-local day", async () => {
    const home = makeTempHome();
    const { createTelemetryCore } = await import("../src/telemetry/telemetryCore.js");
    const fetchMock = vi.fn<typeof fetch>();

    // 15:30 UTC = 上海 23:30（4 月 2 日），16:30 UTC = 上海次日 00:30：按客户端时区而不是 UTC 去重。
    const lateNightUuid = vi.fn(() => "event-local-1");
    const lateNight = createTelemetryCore({
      fetchImpl: fetchMock,
      randomUUID: lateNightUuid,
      now: () => Date.UTC(2026, 3, 2, 15, 30, 0),
    });
    await lateNight.reportAppDailyActive(context);
    expect(readState(home)).toMatchObject({ lastDailyActiveDate: "2026-04-02" });
    expect(readState(home)).not.toHaveProperty("dailyActiveInFlight");
    const callsAfterFirst = lateNightUuid.mock.calls.length;
    expect(callsAfterFirst).toBeGreaterThan(0);

    // 同一本地日再次触发：直接去重，不再生成事件 ID。
    await lateNight.reportAppDailyActive(context);
    expect(lateNightUuid).toHaveBeenCalledTimes(callsAfterFirst);

    const afterMidnightUuid = vi.fn(() => "event-local-2");
    const afterMidnight = createTelemetryCore({
      fetchImpl: fetchMock,
      randomUUID: afterMidnightUuid,
      now: () => Date.UTC(2026, 3, 2, 16, 30, 0),
    });
    await afterMidnight.reportAppDailyActive(context);
    expect(afterMidnightUuid).toHaveBeenCalledTimes(1);
    expect(readState(home)).toMatchObject({ lastDailyActiveDate: "2026-04-03" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("deduplicates concurrent daily active reports across service instances", async () => {
    const home = makeTempHome();
    const { createTelemetryCore } = await import("../src/telemetry/telemetryCore.js");
    const now = () => Date.UTC(2026, 3, 2, 10, 0, 0);
    const firstUuid = vi.fn(() => "event-concurrent-1");
    const secondUuid = vi.fn(() => "event-concurrent-2");
    const first = createTelemetryCore({ randomUUID: firstUuid, now });
    const second = createTelemetryCore({ randomUUID: secondUuid, now });

    await Promise.all([first.reportAppDailyActive(context), second.reportAppDailyActive(context)]);

    // 只有一个实例真正进入上报分支（生成事件 ID），另一个被 state 锁内的标记去重。
    const reporters = [firstUuid, secondUuid].filter((uuid) => uuid.mock.calls.length > 0);
    expect(reporters).toHaveLength(1);
    expect(readState(home)).toMatchObject({ lastDailyActiveDate: "2026-04-02" });
    expect(readState(home)).not.toHaveProperty("dailyActiveInFlight");
  });

  it("recovers from a stale telemetry lock file", async () => {
    const home = makeTempHome();
    const lockFile = join(stateDirOf(home), "telemetry-state.lock");
    mkdirSync(stateDirOf(home), { recursive: true });
    writeFileSync(lockFile, "", "utf-8");
    const staleAt = new Date(Date.UTC(2026, 3, 1, 0, 0, 0));
    utimesSync(lockFile, staleAt, staleAt);

    const { createTelemetryCore } = await import("../src/telemetry/telemetryCore.js");
    const service = createTelemetryCore({
      randomUUID: () => "launch-after-stale-lock",
      now: () => Date.UTC(2026, 3, 2, 10, 0, 0),
    });

    await service.reportAppLaunch(context);

    expect(readState(home)).toEqual({ deviceMid: "launch-after-stale-lock" });
    expect(existsSync(lockFile)).toBe(false);
  });

  it("recovers from a fresh telemetry lock owned by a dead process", async () => {
    const home = makeTempHome();
    const lockFile = join(stateDirOf(home), "telemetry-state.lock");
    mkdirSync(stateDirOf(home), { recursive: true });
    writeFileSync(
      lockFile,
      JSON.stringify({
        pid: 99999999,
        createdAt: Date.UTC(2026, 3, 2, 10, 0, 0),
      }),
      "utf-8",
    );

    const { createTelemetryCore } = await import("../src/telemetry/telemetryCore.js");
    const service = createTelemetryCore({
      randomUUID: () => "launch-after-dead-owner-lock",
      now: () => Date.UTC(2026, 3, 2, 10, 0, 1),
    });

    await service.reportAppLaunch(context);

    expect(readState(home)).toEqual({ deviceMid: "launch-after-dead-owner-lock" });
    expect(existsSync(lockFile)).toBe(false);
  });

  it("does not reacquire the state lock for every custom event after device_mid is cached", async () => {
    const home = makeTempHome();
    mkdirSync(stateDirOf(home), { recursive: true });
    writeFileSync(
      join(stateDirOf(home), "telemetry-state.json"),
      JSON.stringify({ deviceMid: "cached-device-mid" }),
      "utf-8",
    );

    const { createTelemetryCore } = await import("../src/telemetry/telemetryCore.js");
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const fetchMock = vi.fn<typeof fetch>();
    const service = createTelemetryCore({
      fetchImpl: fetchMock,
      randomUUID: () => "cached-event-id",
    });

    await Promise.all(
      Array.from({ length: 500 }, (_, index) =>
        service.reportEvent({
          context,
          elementName: "agent_step",
          eventRegion: "app",
          eventType: "agent_trace",
          eventExtraDetail: { index: String(index) },
        }),
      ),
    );

    expect(consoleSpy).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(readState(home)).toEqual({ deviceMid: "cached-device-mid" });
  });

  it("persists a stable device_mid across service restarts, decoupled from event_id", async () => {
    const home = makeTempHome();
    const { createTelemetryCore, ensureTelemetryDeviceMid } =
      await import("../src/telemetry/telemetryCore.js");

    function sequentialUuid(prefix: string): () => string {
      let counter = 0;
      return () => `${prefix}-${(counter += 1)}`;
    }

    await createTelemetryCore({ randomUUID: sequentialUuid("first") }).reportAppLaunch(context);
    // 首次：eventId 取 first-1，device_mid 是另一次独立调用 first-2（与 event_id 解耦）。
    expect(readState(home)).toEqual({ deviceMid: "first-2" });

    await createTelemetryCore({ randomUUID: sequentialUuid("second") }).reportAppLaunch(context);
    // 重启后复用落盘值，不生成第二个设备身份。
    expect(readState(home)).toEqual({ deviceMid: "first-2" });
    await expect(ensureTelemetryDeviceMid()).resolves.toBe("first-2");
  });

  it("keeps an existing persisted device_mid (back-compat with legacy event-id values)", async () => {
    const home = makeTempHome();
    // 老版本把首条事件的 eventId 当作 device_mid 落盘；新逻辑必须原样复用，不得突变
    mkdirSync(stateDirOf(home), { recursive: true });
    writeFileSync(
      join(stateDirOf(home), "telemetry-state.json"),
      JSON.stringify({ deviceMid: "legacy-event-id-from-old-version" }),
      "utf-8",
    );

    const { createTelemetryCore, ensureTelemetryDeviceMid } =
      await import("../src/telemetry/telemetryCore.js");
    await createTelemetryCore({ randomUUID: () => "fresh-event-id" }).reportAppLaunch(context);

    expect(readState(home)).toEqual({ deviceMid: "legacy-event-id-from-old-version" });
    await expect(ensureTelemetryDeviceMid()).resolves.toBe("legacy-event-id-from-old-version");
  });
});
