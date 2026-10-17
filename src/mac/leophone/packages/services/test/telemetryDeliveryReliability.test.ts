import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

// [leo] LeoPhoneAgent 不向官方上报遥测（ZCODE_TELEMETRY_REPORT_ENDPOINT 恒为 ""），
// 上游的 HTTP 重试 / 超时中止 / 失败告警 / session_create 跨 HTTP 重试同 ID 用例随出网上报一并移除。
// 退出前 drain（flushPendingReports）仍是活代码：上报在读取 userId 等本地步骤上仍可能挂起，
// 这里用挂起的 loadUserId 代替上游挂起的 fetch 来覆盖它。

const tempHomes: string[] = [];

function makeTempHome(): string {
  const home = mkdtempSync(join(tmpdir(), "zcode-telemetry-delivery-"));
  tempHomes.push(home);
  return home;
}

async function waitForCalls(mock: ReturnType<typeof vi.fn>, expectedCalls: number): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (mock.mock.calls.length === expectedCalls) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  expect(mock).toHaveBeenCalledTimes(expectedCalls);
}

afterEach(() => {
  vi.restoreAllMocks();
  while (tempHomes.length > 0) {
    const home = tempHomes.pop();
    if (home) rmSync(home, { recursive: true, force: true });
  }
});

const context = {
  clientTimezone: "Asia/Shanghai",
  clientLanguage: "zh-CN",
  screenResolution: "1920x1080",
};

describe("telemetry delivery reliability", () => {
  it("flushes reports added while an app-quit drain is already waiting", async () => {
    const home = makeTempHome();
    const { createTelemetryCore } = await import("../src/telemetry/telemetryCore.js");
    const releases: Array<() => void> = [];
    const loadUserId = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          releases.push(() => resolve("user-1"));
        }),
    );
    const fetchMock = vi.fn<typeof fetch>();
    const service = createTelemetryCore({ fetchImpl: fetchMock, homeDir: home, loadUserId });

    const firstReport = service.reportAppLaunch(context);
    await waitForCalls(loadUserId, 1);
    let flushed = false;
    const flush = service.flushPendingReports({ timeoutMs: 1_000 }).then(() => {
      flushed = true;
    });
    const secondReport = service.reportAppLaunch(context);
    await waitForCalls(loadUserId, 2);

    releases[0]?.();
    await firstReport;
    await Promise.resolve();
    expect(flushed).toBe(false);

    releases[1]?.();
    await Promise.all([secondReport, flush]);
    expect(flushed).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("stops waiting for pending reports when the flush deadline expires", async () => {
    const home = makeTempHome();
    const { createTelemetryCore } = await import("../src/telemetry/telemetryCore.js");
    let releaseUserId: (() => void) | undefined;
    const loadUserId = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          releaseUserId = () => resolve("user-1");
        }),
    );
    const warn = vi.fn();
    const service = createTelemetryCore({ homeDir: home, loadUserId, warn });

    const report = service.reportAppLaunch(context);
    await waitForCalls(loadUserId, 1);
    await service.flushPendingReports({ timeoutMs: 5 });

    expect(warn).toHaveBeenCalledWith("Telemetry flush timed out; pending=1");
    releaseUserId?.();
    await report;
  });
});
