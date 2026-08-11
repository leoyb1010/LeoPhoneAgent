/**
 * Keep the stdio browser-use MCP proxy from outliving the agent CLI that spawned
 * it. When the parent (claude/codex/…) is SIGKILLed, the stdio pipe may not emit
 * 'end', so the proxy can get reparented to init and linger as an orphan. A tiny
 * parent-liveness poll makes it exit instead. Kept in its own module so tests can
 * import isParentAlive without triggering browser-use-mcp.ts's stdin side-effects.
 *
 * Liveness check mirrors electron/localServer.js:isProcessAlive.
 */
export function isParentAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 1) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // ESRCH => the parent is gone; EPERM => it exists but we can't signal it (still alive).
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Arm a watchdog that exits the current process once its original parent is gone.
 * Returns a stop function (used by tests); no-op when already orphaned at start.
 */
export function armParentWatchdog(
  exit: (code: number) => void = (code) => process.exit(code),
  intervalMs = 1000,
): () => void {
  const parentPid = process.ppid;
  if (parentPid <= 1) {
    return () => {};
  }
  const timer = setInterval(() => {
    // process.ppid !== parentPid catches reparent-to-init even if the old pid is reused.
    if (!isParentAlive(parentPid) || process.ppid !== parentPid) {
      clearInterval(timer);
      exit(0);
    }
  }, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
