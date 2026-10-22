import type { ChildProcess, SpawnSyncReturns } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// [up3-runtime] 进程表查询的缓冲区回归:全表扫描不再带 command=,command 只按候选 PID 补读;
// ENOBUFS 记错误日志,不把整张表当空。spawnSync 换成桩,输出完全由用例决定。
const spawnSyncMock = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawnSync: spawnSyncMock,
}));

const { captureProcessTreeSnapshot, filterCurrentProcessIdentities } = await import(
  "#src/process/processTreeSnapshot.js"
);

const LSTART = "Wed Oct 22 14:05:41 2026";
const FULL_SCAN = [
  `    1     0     1 ${LSTART}`,
  `  500     1   500 ${LSTART}`,
  `  501   500   500 ${LSTART}`,
  `  502   501   500 ${LSTART}`,
  `  900     1   900 ${LSTART}`,
].join("\n");

function psResult(stdout: string, extra: Partial<SpawnSyncReturns<string>> = {}) {
  return { pid: 1, output: [], stdout, stderr: "", status: 0, signal: null, ...extra };
}

function commandScan(pids: readonly number[]): string {
  const rows: Record<number, string> = {
    500: `  500     1   500 ${LSTART} /Applications/LeoBot.app/zcode agent`,
    501: `  501   500   500 ${LSTART} node mcp-server.js --stdio`,
    502: `  502   501   500 ${LSTART} /bin/zsh -c sleep 100`,
  };
  return pids.flatMap((pid) => (rows[pid] ? [rows[pid]] : [])).join("\n");
}

function routePs(fullScan: () => ReturnType<typeof psResult>) {
  spawnSyncMock.mockImplementation((_command: string, args: readonly string[]) => {
    const pidIndex = args.indexOf("-p");
    if (pidIndex >= 0) {
      const pids = (args[pidIndex + 1] ?? "").split(",").map(Number);
      return psResult(commandScan(pids));
    }
    return fullScan();
  });
}

const originalPlatform = process.platform;

describe.skipIf(originalPlatform === "win32")("processTreeSnapshot ps buffering (darwin)", () => {
  beforeEach(() => {
    Object.defineProperty(process, "platform", { value: "darwin" });
    spawnSyncMock.mockReset();
  });
  afterEach(() => {
    Object.defineProperty(process, "platform", { value: originalPlatform });
  });

  it("scans pid/ppid/pgid/lstart only and reads command for candidate pids", () => {
    routePs(() => psResult(FULL_SCAN));
    const snapshot = captureProcessTreeSnapshot({ pid: 500 } as ChildProcess);

    expect(snapshot?.descendantPids).toEqual([501, 502]);
    expect(snapshot?.identities.find((identity) => identity.pid === 502)?.startTime).toBe(
      `${LSTART}|command:/bin/zsh -c sleep 100`,
    );
    const [fullScanCall, commandCall] = spawnSyncMock.mock.calls;
    expect(fullScanCall?.[1]).toEqual(["-axo", "pid=,ppid=,pgid=,lstart="]);
    expect(fullScanCall?.[2]).toMatchObject({ maxBuffer: 16 * 1024 * 1024 });
    expect(commandCall?.[1]).toEqual(["-o", "pid=,ppid=,pgid=,lstart=,command=", "-p", "500,501,502"]);
    expect(commandCall?.[2]).toMatchObject({ maxBuffer: 16 * 1024 * 1024 });
    // 无关进程(900)的命令行从不读取。
    expect(spawnSyncMock.mock.calls.some((call) => String(call[1]).includes("900"))).toBe(false);
  });

  it("drops a candidate whose pid was reused between the scan and the command read", () => {
    spawnSyncMock.mockImplementation((_command: string, args: readonly string[]) =>
      args.includes("-p")
        ? psResult(
            [
              `  500     1   500 ${LSTART} /Applications/LeoBot.app/zcode agent`,
              `  501   500   500 ${LSTART} node mcp-server.js --stdio`,
              `  502     1   502 Wed Oct 22 14:09:00 2026 /usr/bin/unrelated`,
            ].join("\n"),
          )
        : psResult(FULL_SCAN),
    );
    const snapshot = captureProcessTreeSnapshot({ pid: 500 } as ChildProcess);
    expect(snapshot?.descendantPids).toEqual([501]);
  });

  it("treats `ps -p` matching nothing as all-exited, not as a failure", () => {
    const log = { warn: vi.fn() };
    spawnSyncMock.mockImplementation((_command: string, args: readonly string[]) =>
      args.includes("-p") ? psResult("", { status: 1 }) : psResult(FULL_SCAN),
    );
    const known = [{ parentPid: 1, pid: 500, processGroupId: 500, startTime: `${LSTART}|command:x` }];
    expect(filterCurrentProcessIdentities(known, { log })).toEqual([]);
    expect(log.warn).not.toHaveBeenCalled();
  });

  it("logs ENOBUFS as an error and still uses the complete lines that were read", () => {
    const log = { warn: vi.fn(), error: vi.fn() };
    const enobufs = Object.assign(new Error("spawnSync ps ENOBUFS"), { code: "ENOBUFS" });
    // 截断发生在最后一行中间:那一行必须丢掉,前面的完整行照常用。
    routePs(() =>
      psResult(`${FULL_SCAN}\n  903     1   903 Wed Oct`, { error: enobufs, status: null, signal: "SIGTERM" }),
    );

    const snapshot = captureProcessTreeSnapshot({ pid: 500 } as ChildProcess, { log });

    expect(snapshot?.descendantPids).toEqual([501, 502]);
    expect(log.error).toHaveBeenCalledWith(
      undefined,
      expect.stringContaining("ENOBUFS"),
      enobufs,
    );
    expect(log.warn).not.toHaveBeenCalled();
  });

  it("falls back to warn for ENOBUFS when the logger has no error method", () => {
    const log = { warn: vi.fn() };
    const enobufs = Object.assign(new Error("spawnSync ps ENOBUFS"), { code: "ENOBUFS" });
    routePs(() => psResult(FULL_SCAN, { error: enobufs, status: null, signal: "SIGTERM" }));
    captureProcessTreeSnapshot({ pid: 500 } as ChildProcess, { log });
    expect(log.warn).toHaveBeenCalledWith(undefined, expect.stringContaining("ENOBUFS"), enobufs);
  });

  it("keeps a reparented descendant when the root exits between the scan and the command read", () => {
    // root(500) 在全表扫描后退出:501 被 reparent 到 launchd,root 不在 -p 补读结果里。
    spawnSyncMock.mockImplementation((_command: string, args: readonly string[]) =>
      args.includes("-p")
        ? psResult(
            [
              `  501     1   500 ${LSTART} node mcp-server.js --stdio`,
              `  502   501   500 ${LSTART} /bin/zsh -c sleep 100`,
            ].join("\n"),
          )
        : psResult(FULL_SCAN),
    );
    const snapshot = captureProcessTreeSnapshot({ pid: 500 } as ChildProcess);
    expect(snapshot?.rootPid).toBe(500);
    expect(snapshot?.descendantPids).toEqual([501, 502]);
    const byPid = new Map(snapshot?.identities.map((identity) => [identity.pid, identity]));
    // ppid 沿用全表扫描,复核过的后代带 command 熵。
    expect(byPid.get(501)).toEqual({
      parentPid: 500,
      pid: 501,
      processGroupId: 500,
      startTime: `${LSTART}|command:node mcp-server.js --stdio`,
    });
    // 已退出 root 的记录不带复核熵,不可能再与任何活进程匹配。
    expect(byPid.get(500)?.startTime).toBe(LSTART);
  });

  it("returns no snapshot when neither the root nor any descendant survives the command read", () => {
    spawnSyncMock.mockImplementation((_command: string, args: readonly string[]) =>
      args.includes("-p") ? psResult("", { status: 1 }) : psResult(FULL_SCAN),
    );
    expect(captureProcessTreeSnapshot({ pid: 500 } as ChildProcess)).toBeUndefined();
  });

  it("still returns no snapshot when ps itself fails", () => {
    const log = { warn: vi.fn() };
    routePs(() => psResult("", { status: 2 }));
    expect(captureProcessTreeSnapshot({ pid: 500 } as ChildProcess, { log })).toBeUndefined();
    expect(log.warn).toHaveBeenCalledWith(undefined, expect.stringContaining("status=2"));
  });
});
