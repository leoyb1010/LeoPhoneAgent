import { spawnSync, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import type {
  ProcessIdentity,
  ProcessTreeSnapshot,
  ProcessTreeTerminatorOptions,
} from "#src/process/processTreeTypes.js";

const PROCESS_LOOKUP_TIMEOUT_MS = 1_000;
// spawnSync 默认 maxBuffer 只有 1 MiB。全表带 command= 时繁忙的 Mac 很容易超过它（ENOBUFS），
// 以前这会让后代清理拿到空表。全表扫描已不带 command=（见 readPosixProcessList），这里再给足余量。
const PROCESS_LIST_MAX_BUFFER_BYTES = 16 * 1024 * 1024;
const POSIX_IDENTITY_COLUMNS = "pid=,ppid=,pgid=,lstart=";
const DARWIN_COMMAND_COLUMNS = "pid=,ppid=,pgid=,lstart=,command=";
const DOTNET_UNIX_EPOCH_TICKS = 621_355_968_000_000_000n;
const TICKS_PER_MILLISECOND = 10_000n;

let windowsProcessListCache: readonly ProcessIdentity[] | undefined;

function warn(options: ProcessTreeTerminatorOptions, message: string, ...args: unknown[]): void {
  options.log?.warn(options.traceId, message, ...args);
}

function logError(options: ProcessTreeTerminatorOptions, message: string, ...args: unknown[]): void {
  const log = options.log;
  if (log?.error) {
    log.error(options.traceId, message, ...args);
    return;
  }
  log?.warn(options.traceId, message, ...args);
}

function parsePositiveInteger(value: string | undefined): number | undefined {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function parseNonNegativeInteger(value: string | undefined): number | undefined {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

function parsePosixProcessList(stdout: string, includeCommand: boolean): ProcessIdentity[] {
  const identities: ProcessIdentity[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const fields = line.trim().split(/\s+/);
    const [pidText, parentPidText, processGroupIdText] = fields;
    const pid = parsePositiveInteger(pidText);
    const parentPid = parseNonNegativeInteger(parentPidText);
    const processGroupId = parsePositiveInteger(processGroupIdText);
    const lstart = fields.slice(3, 8).join(" ");
    const command = includeCommand ? fields.slice(8).join(" ") : "";
    // Darwin 的 ps 只暴露秒级 lstart；候选 PID 补读时追加完整 command 作为复用校验熵。
    // Linux 随后会用 /proc start ticks 覆盖该值。
    const startTime = includeCommand ? `${lstart}|command:${command}` : lstart;
    if (pid === undefined || parentPid === undefined || !processGroupId || !startTime) {
      continue;
    }
    identities.push({ parentPid, pid, processGroupId, startTime });
  }
  return identities;
}

function parseWindowsProcessList(stdout: string): ProcessIdentity[] {
  const identities: ProcessIdentity[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const [pidText, parentPidText, startTime] = line.trim().split(/\s+/);
    const pid = parsePositiveInteger(pidText);
    const parentPid = parseNonNegativeInteger(parentPidText);
    if (pid === undefined || parentPid === undefined || !startTime) {
      continue;
    }
    identities.push({ parentPid, pid, startTime });
  }
  return identities;
}

function parseWindowsCreationTimeMs(startTime: string): number | undefined {
  try {
    const unixTicks = BigInt(startTime) - DOTNET_UNIX_EPOCH_TICKS;
    const timestamp = Number(unixTicks / TICKS_PER_MILLISECOND);
    return Number.isSafeInteger(timestamp) ? timestamp : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 跑一次 ps，返回 stdout；失败返回 undefined（已记日志）。
 * - ENOBUFS 当作错误记下来，但不把整张表当空：只丢掉最后一条可能被截断的行，其余完整行照常用。
 * - `allowNoMatch`：`ps -p` 一个都没找到时 BSD/procps 都回 status 1 + 空输出，这是「都已退出」，不是失败。
 */
function runPosixPs(
  args: readonly string[],
  options: ProcessTreeTerminatorOptions,
  allowNoMatch = false,
): string | undefined {
  const result = spawnSync("ps", args, {
    encoding: "utf8",
    maxBuffer: PROCESS_LIST_MAX_BUFFER_BYTES,
    timeout: PROCESS_LOOKUP_TIMEOUT_MS,
  });
  if ((result.error as NodeJS.ErrnoException | undefined)?.code === "ENOBUFS") {
    logError(
      options,
      `查询 runtime 后代进程失败（进程表超过 ${PROCESS_LIST_MAX_BUFFER_BYTES} 字节缓冲，ENOBUFS），只使用已读到的完整行:`,
      result.error,
    );
    const stdout = typeof result.stdout === "string" ? result.stdout : "";
    return stdout.slice(0, stdout.lastIndexOf("\n") + 1);
  }
  if (result.error) {
    warn(options, "查询 runtime 后代进程失败（进程表查询）:", result.error);
    return undefined;
  }
  if (result.signal === "SIGTERM" || result.signal === "SIGKILL") {
    warn(options, `查询 runtime 后代进程失败（进程表超时） signal=${result.signal}`);
    return undefined;
  }
  if (allowNoMatch && result.status === 1 && !result.stdout?.trim()) {
    return "";
  }
  if (result.status !== 0 || !result.stdout) {
    warn(options, `查询 runtime 后代进程失败（进程表查询） status=${result.status ?? "unknown"}`);
    return undefined;
  }
  return result.stdout;
}

function readPosixProcessList(options: ProcessTreeTerminatorOptions): ProcessIdentity[] {
  // 全表扫描只读 pid/ppid/pgid/lstart；Darwin 需要的 command 熵只在
  // refineDarwinProcessIdentities 里按候选 PID 补读，不再把整机每条命令行都读进来。
  const stdout = runPosixPs(
    process.platform === "darwin"
      ? ["-axo", POSIX_IDENTITY_COLUMNS]
      : ["-eo", POSIX_IDENTITY_COLUMNS],
    options,
  );
  return stdout === undefined ? [] : parsePosixProcessList(stdout, false);
}

/**
 * Darwin 的 lstart 只有秒级精度，身份里还要追加完整 command 作为 PID 复用校验熵。
 * 只对候选 PID 补读一次（带 command=）；PID 复用按 pid + pgid + lstart(+command) 判定，
 * 对不上的直接丢弃。ppid 不参与判定：root 在两次读取之间退出时后代会被 reparent 到 launchd，
 * 身份并未改变，ppid 一律沿用全表扫描时的值，进程树结构保持一致。
 */
function refineDarwinProcessIdentities(
  identities: readonly ProcessIdentity[],
  options: ProcessTreeTerminatorOptions,
): ProcessIdentity[] {
  if (identities.length === 0) {
    return [];
  }
  const stdout = runPosixPs(
    ["-o", DARWIN_COMMAND_COLUMNS, "-p", identities.map((identity) => identity.pid).join(",")],
    options,
    true,
  );
  if (stdout === undefined) {
    return [];
  }
  const withCommandByPid = new Map(
    parsePosixProcessList(stdout, true).map((identity) => [identity.pid, identity]),
  );
  return identities.flatMap((identity) => {
    const withCommand = withCommandByPid.get(identity.pid);
    if (
      !withCommand ||
      withCommand.processGroupId !== identity.processGroupId ||
      !withCommand.startTime.startsWith(`${identity.startTime}|command:`)
    ) {
      return [];
    }
    return [{ ...withCommand, parentPid: identity.parentPid }];
  });
}

function readWindowsProcessList(options: ProcessTreeTerminatorOptions): readonly ProcessIdentity[] {
  if (windowsProcessListCache) {
    return windowsProcessListCache;
  }
  const result = spawnSync(
    "powershell.exe",
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "Get-CimInstance Win32_Process | ForEach-Object { '{0} {1} {2}' -f $_.ProcessId, $_.ParentProcessId, $_.CreationDate.ToUniversalTime().Ticks }",
    ],
    {
      encoding: "utf8",
      timeout: PROCESS_LOOKUP_TIMEOUT_MS,
      windowsHide: true,
    },
  );
  if (result.error || result.status !== 0 || !result.stdout) {
    warn(
      options,
      `查询 Windows runtime 进程表失败 status=${result.status ?? "unknown"}:`,
      result.error ?? result.stderr,
    );
    return [];
  }
  const identities = parseWindowsProcessList(result.stdout);
  windowsProcessListCache = identities;
  // 同一轮 app quit 会同步抓取多个 workspace，复用同一份带 CreationDate 的系统进程表；
  // 下个 microtask 立即失效，避免稍后的 restart/quit 把 PID 复用误判成旧进程。
  queueMicrotask(() => {
    if (windowsProcessListCache === identities) {
      windowsProcessListCache = undefined;
    }
  });
  return identities;
}

function readProcessList(options: ProcessTreeTerminatorOptions): readonly ProcessIdentity[] {
  return process.platform === "win32"
    ? readWindowsProcessList(options)
    : readPosixProcessList(options);
}

function refineLinuxProcessIdentity(identity: ProcessIdentity): ProcessIdentity | undefined {
  if (process.platform !== "linux") {
    return identity;
  }
  try {
    const stat = readFileSync(`/proc/${identity.pid}/stat`, "utf8");
    const commandEnd = stat.lastIndexOf(")");
    if (commandEnd < 0) {
      return undefined;
    }
    // /proc/<pid>/stat 的 field 22 是自 boot 起的启动 tick；精度高于 ps lstart
    // 的秒级时间，PID 在同一秒被复用时也不会被误认成旧 runtime 成员。
    const fieldsAfterCommand = stat
      .slice(commandEnd + 2)
      .trim()
      .split(/\s+/);
    const parentPid = parseNonNegativeInteger(fieldsAfterCommand[1]);
    const processGroupId = parsePositiveInteger(fieldsAfterCommand[2]);
    const startTimeTicks = fieldsAfterCommand[19];
    if (
      parentPid === undefined ||
      !processGroupId ||
      !startTimeTicks ||
      parentPid !== identity.parentPid ||
      processGroupId !== identity.processGroupId
    ) {
      // ps 与 /proc 两次读取间发生 PID 复用/reparent 时，不能拼出混合身份。
      return undefined;
    }
    return {
      ...identity,
      parentPid,
      processGroupId,
      startTime: `linux-ticks:${startTimeTicks}`,
    };
  } catch {
    return undefined;
  }
}

function refineProcessIdentities(
  identities: readonly ProcessIdentity[],
  options: ProcessTreeTerminatorOptions,
): ProcessIdentity[] {
  if (process.platform === "darwin") {
    return refineDarwinProcessIdentities(identities, options);
  }
  if (process.platform !== "linux") {
    return [...identities];
  }
  return identities
    .map((identity) => refineLinuxProcessIdentity(identity))
    .filter((identity): identity is ProcessIdentity => identity !== undefined);
}

function collectDescendantIdentitiesFromProcessList(
  rootPid: number,
  identities: readonly ProcessIdentity[],
): ProcessIdentity[] {
  const childrenByParentPid = new Map<number, ProcessIdentity[]>();
  for (const identity of identities) {
    const children = childrenByParentPid.get(identity.parentPid) ?? [];
    children.push(identity);
    childrenByParentPid.set(identity.parentPid, children);
  }

  const descendants: ProcessIdentity[] = [];
  const seen = new Set<number>([rootPid]);
  const visit = (pid: number) => {
    for (const child of childrenByParentPid.get(pid) ?? []) {
      if (seen.has(child.pid)) {
        continue;
      }
      seen.add(child.pid);
      descendants.push(child);
      visit(child.pid);
    }
  };
  visit(rootPid);
  return descendants;
}

export function filterCurrentProcessIdentities(
  identities: readonly ProcessIdentity[],
  options: ProcessTreeTerminatorOptions,
): ProcessIdentity[] {
  if (identities.length === 0) {
    return [];
  }
  const trackedPids = new Set(identities.map((identity) => identity.pid));
  const currentByPid = new Map(
    refineProcessIdentities(
      readProcessList(options).filter((identity) => trackedPids.has(identity.pid)),
      options,
    ).map((identity) => [identity.pid, identity]),
  );
  return identities.filter((identity) => {
    const current = currentByPid.get(identity.pid);
    return (
      current?.startTime === identity.startTime &&
      (identity.processGroupId === undefined || current.processGroupId === identity.processGroupId)
    );
  });
}

export function captureProcessTreeSnapshot(
  child: ChildProcess,
  options: ProcessTreeTerminatorOptions = {},
): ProcessTreeSnapshot | undefined {
  if (child.pid == null) {
    return undefined;
  }
  const processList = readProcessList(options);
  const rootIdentity = processList.find((identity) => identity.pid === child.pid);
  if (!rootIdentity) {
    // 没有创建标识的 rootPid 不能形成进程所有权；返回半截快照会让
    // 延迟回收在 PID 复用后重新沿裸 root PID 认领无关进程树。
    return undefined;
  }
  const descendantIdentities = collectDescendantIdentitiesFromProcessList(child.pid, processList);
  // POSIX detached root 是自己进程组的 leader；若它在 ps 扫描期间退出，
  // 后代会被 reparent，单靠 PPID 链会漏掉仍属于该 owned PGID 的进程。仅在
  // PGID === root PID 时合并同组成员，避免把普通 child 所在的宿主进程组纳入快照。
  const ownedProcessGroupIdentities =
    process.platform !== "win32" && rootIdentity.processGroupId === child.pid
      ? processList.filter((identity) => identity.processGroupId === child.pid)
      : [];
  const snapshotCandidates = new Map(
    [rootIdentity, ...descendantIdentities, ...ownedProcessGroupIdentities].map((identity) => [
      identity.pid,
      identity,
    ]),
  );
  const refinedIdentities = refineProcessIdentities([...snapshotCandidates.values()], options);
  // root 在全表扫描后、身份复核前退出时（Darwin 按候选 PID 补读 command 有一次 spawnSync 的间隙），
  // 复核结果里没有 root，但全表扫描已证明它是本次快照的拥有者。保留扫描时的 root 记录：
  // 它的 startTime 不带复核熵，永远不会与之后读到的任何活进程匹配，只作「已退出 root」标记，
  // 同组后代仍按复核过的身份回收，不会因此认领复用 PID。没有任何复核过的后代时仍返回 undefined。
  const identities = refinedIdentities.some((identity) => identity.pid === child.pid)
    ? refinedIdentities
    : process.platform === "win32" || refinedIdentities.length === 0
      ? []
      : [rootIdentity, ...refinedIdentities];
  if (identities.length === 0) {
    return undefined;
  }
  return {
    rootPid: child.pid,
    descendantPids: identities
      .filter((identity) => identity.pid !== child.pid)
      .map((identity) => identity.pid),
    identities,
  };
}

export function captureProcessGroupSnapshot(
  processGroupId: number,
  options: ProcessTreeTerminatorOptions = {},
): ProcessTreeSnapshot | undefined {
  if (process.platform === "win32" || !Number.isInteger(processGroupId) || processGroupId <= 0) {
    return undefined;
  }
  // POSIX detached Agent 的 root 可能先于同组 MCP/工具进程退出，
  // 此时 PPID 已经变化，但内核会在最后一个成员退出前保留原 PGID。只在 cleanup
  // 边界按 Host spawn 时拥有的 PGID 查询，避免把进程表扫描带入协议消息热路径。
  const identities = refineProcessIdentities(
    readProcessList(options).filter((identity) => identity.processGroupId === processGroupId),
    options,
  );
  if (identities.length === 0) {
    return undefined;
  }
  return {
    rootPid: processGroupId,
    descendantPids: identities
      .filter((identity) => identity.pid !== processGroupId)
      .map((identity) => identity.pid),
    identities,
  };
}

export function captureExitedRootDescendantsSnapshot(
  rootPid: number,
  options: ProcessTreeTerminatorOptions = {},
): ProcessTreeSnapshot | undefined {
  const startedAtMs = options.ownedProcessStartedAtMs;
  const exitedAtMs = options.ownedProcessExitedAtMs;
  if (
    process.platform !== "win32" ||
    !Number.isInteger(rootPid) ||
    rootPid <= 0 ||
    typeof startedAtMs !== "number" ||
    !Number.isFinite(startedAtMs) ||
    typeof exitedAtMs !== "number" ||
    !Number.isFinite(exitedAtMs)
  ) {
    return undefined;
  }
  // Windows Win32_Process 会保留创建者 ParentProcessId，即使 CLI root
  // 已经退出。裸 ParentProcessId 会在 PID 复用后误认领无关进程，因此候选成员的
  // CreationDate 还必须落在 Host 记录的 root 生命周期内；后续 force 再按同一
  // CreationDate 复核，不能向已经复用的 descendant PID 发信号。
  const processList = readProcessList(options).filter((identity) => {
    const createdAtMs = parseWindowsCreationTimeMs(identity.startTime);
    return createdAtMs !== undefined && createdAtMs >= startedAtMs && createdAtMs <= exitedAtMs;
  });
  const identities = collectDescendantIdentitiesFromProcessList(rootPid, processList);
  if (identities.length === 0) {
    return undefined;
  }
  return {
    rootPid,
    descendantPids: identities.map((identity) => identity.pid),
    identities,
  };
}
