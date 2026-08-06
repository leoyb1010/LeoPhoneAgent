import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { sameFileIdentity } from "./file-identity.js";
const GLOBAL_STATE_KEY = Symbol.for("fsSafe.sidecarLockManagers");
function getGlobalManagers() {
    const globalWithState = globalThis;
    if (!globalWithState[GLOBAL_STATE_KEY]) {
        globalWithState[GLOBAL_STATE_KEY] = new Map();
    }
    return globalWithState[GLOBAL_STATE_KEY];
}
function resolveManagerState(key) {
    const managers = getGlobalManagers();
    let state = managers.get(key);
    if (!state) {
        state = { cleanupRegistered: false, held: new Map() };
        managers.set(key, state);
    }
    return state;
}
async function readLockSnapshot(lockPath) {
    try {
        const stat = await fs.lstat(lockPath);
        const raw = await fs.readFile(lockPath, "utf8");
        try {
            const parsed = JSON.parse(raw);
            const payload = parsed && typeof parsed === "object" && !Array.isArray(parsed)
                ? parsed
                : null;
            return { raw, payload, stat };
        }
        catch {
            return { raw, payload: null, stat };
        }
    }
    catch (err) {
        if (err.code === "ENOENT") {
            return null;
        }
        throw err;
    }
}
function snapshotMatches(current, observed) {
    if (observed.stat && current.stat && !sameFileIdentity(observed.stat, current.stat)) {
        return false;
    }
    if (observed.raw !== undefined) {
        return current.raw === observed.raw;
    }
    return observed.stat !== undefined && current.stat !== undefined;
}
async function removeLockIfUnchanged(lockPath, observed) {
    const current = await readLockSnapshot(lockPath);
    if (!current || !observed) {
        return false;
    }
    if (!snapshotMatches(current, observed)) {
        // The lock changed after we decided it was stale. Leave the fresh holder's
        // file alone; deleting by path here would break mutual exclusion.
        return false;
    }
    await fs.rm(lockPath, { force: true }).catch(() => undefined);
    return true;
}
async function lockSnapshotStillPresent(lockPath, observed) {
    const current = await readLockSnapshot(lockPath);
    return !!current && !!observed && snapshotMatches(current, observed);
}
async function removeStaleLockIfAllowed(params) {
    if (!params.shouldRemoveStaleLock) {
        return "not-approved";
    }
    if (params.snapshot.raw === undefined) {
        return "not-approved";
    }
    if (!(await params.shouldRemoveStaleLock({
        lockPath: params.lockPath,
        normalizedTargetPath: params.normalizedTargetPath,
        raw: params.snapshot.raw,
        payload: params.snapshot.payload,
    }))) {
        return "not-approved";
    }
    const current = await readLockSnapshot(params.lockPath);
    if (!current || !snapshotMatches(current, params.snapshot)) {
        return "changed";
    }
    try {
        await fs.rm(params.lockPath, { force: true });
    }
    catch (err) {
        if (err.code === "ENOENT") {
            return "changed";
        }
        return "not-approved";
    }
    return "removed";
}
function snapshotMatchesSync(lockPath, observed) {
    try {
        const stat = fsSync.lstatSync(lockPath);
        if (observed.stat && !sameFileIdentity(observed.stat, stat)) {
            return false;
        }
        return observed.raw === undefined || fsSync.readFileSync(lockPath, "utf8") === observed.raw;
    }
    catch {
        return false;
    }
}
async function resolveNormalizedTargetPath(targetPath) {
    const resolved = path.resolve(targetPath);
    const dir = path.dirname(resolved);
    await fs.mkdir(dir, { recursive: true });
    try {
        return path.join(await fs.realpath(dir), path.basename(resolved));
    }
    catch {
        return resolved;
    }
}
function computeDelayMs(retry, attempt) {
    const minTimeout = retry.minTimeout ?? 50;
    const maxTimeout = retry.maxTimeout ?? 1000;
    const factor = retry.factor ?? 1;
    const base = Math.min(maxTimeout, Math.max(minTimeout, minTimeout * factor ** attempt));
    const jitter = retry.randomize ? 1 + Math.random() : 1;
    return Math.min(maxTimeout, Math.round(base * jitter));
}
async function defaultShouldReclaim(params) {
    const createdAt = typeof params.payload?.createdAt === "string" ? params.payload.createdAt : "";
    const createdAtMs = Date.parse(createdAt);
    if (Number.isFinite(createdAtMs) && params.nowMs - createdAtMs > params.staleMs) {
        return true;
    }
    try {
        const stat = await fs.stat(params.lockPath);
        return params.nowMs - stat.mtimeMs > params.staleMs;
    }
    catch {
        return true;
    }
}
function releaseAllLocksSync(state) {
    for (const [normalizedTargetPath, held] of state.held) {
        void held.handle.close().catch(() => undefined);
        try {
            if (snapshotMatchesSync(held.lockPath, held.snapshot)) {
                fsSync.rmSync(held.lockPath, { force: true });
            }
        }
        catch {
            // Best-effort process-exit cleanup.
        }
        state.held.delete(normalizedTargetPath);
    }
}
async function releaseHeldLock(state, normalizedTargetPath, held, opts = {}) {
    const current = state.held.get(normalizedTargetPath);
    if (current !== held) {
        return false;
    }
    if (opts.force) {
        held.count = 0;
    }
    else {
        held.count -= 1;
        if (held.count > 0) {
            return false;
        }
    }
    if (held.releasePromise) {
        await held.releasePromise.catch(() => undefined);
        return true;
    }
    state.held.delete(normalizedTargetPath);
    held.releasePromise = (async () => {
        await held.handle.close().catch(() => undefined);
        await removeLockIfUnchanged(held.lockPath, held.snapshot);
    })();
    try {
        await held.releasePromise;
        return true;
    }
    finally {
        held.releasePromise = undefined;
    }
}
export function createSidecarLockManager(key) {
    const state = resolveManagerState(key);
    function ensureExitCleanupRegistered() {
        if (state.cleanupRegistered) {
            return;
        }
        state.cleanupRegistered = true;
        process.on("exit", () => releaseAllLocksSync(state));
    }
    async function acquire(options) {
        ensureExitCleanupRegistered();
        const normalizedTargetPath = await resolveNormalizedTargetPath(options.targetPath);
        const lockPath = options.lockPath ?? `${normalizedTargetPath}.lock`;
        const held = state.held.get(normalizedTargetPath);
        if (held && options.allowReentrant) {
            held.count += 1;
            const release = () => releaseHeldLock(state, normalizedTargetPath, held).then(() => undefined);
            return {
                lockPath,
                normalizedTargetPath,
                release,
                [Symbol.asyncDispose]: release,
            };
        }
        const startedAt = Date.now();
        const retry = options.retry ?? {};
        const maxRetries = options.timeoutMs === Number.POSITIVE_INFINITY ? undefined : retry.retries;
        let attempt = 0;
        while (true) {
            let handle = null;
            try {
                handle = await fs.open(lockPath, "wx");
                const payload = await options.payload();
                const raw = `${JSON.stringify(payload, null, 2)}\n`;
                await handle.writeFile(raw, "utf8");
                const snapshot = { raw, payload, stat: await handle.stat() };
                const createdHeld = {
                    count: 1,
                    handle,
                    lockPath,
                    snapshot,
                    acquiredAt: Date.now(),
                    metadata: options.metadata ?? {},
                };
                state.held.set(normalizedTargetPath, createdHeld);
                const release = () => releaseHeldLock(state, normalizedTargetPath, createdHeld).then(() => undefined);
                return {
                    lockPath,
                    normalizedTargetPath,
                    release,
                    [Symbol.asyncDispose]: release,
                };
            }
            catch (err) {
                if (handle) {
                    const failedSnapshot = { payload: null };
                    try {
                        failedSnapshot.stat = await handle.stat();
                    }
                    catch {
                        // Best-effort cleanup of a failed exclusive create.
                    }
                    const current = state.held.get(normalizedTargetPath);
                    if (current?.handle === handle) {
                        state.held.delete(normalizedTargetPath);
                    }
                    // If payload serialization/write fails, the file may be empty or
                    // partial JSON, so remove while our exclusive handle is still open.
                    await fs.rm(lockPath, { force: true }).catch(() => undefined);
                    await handle.close().catch(() => undefined);
                    // Windows can refuse removing an open file; retry after close but
                    // only if the path still points at the file identity we created.
                    await removeLockIfUnchanged(lockPath, failedSnapshot);
                }
                if (err.code !== "EEXIST") {
                    throw err;
                }
                const nowMs = Date.now();
                const snapshot = await readLockSnapshot(lockPath);
                if (!snapshot) {
                    continue;
                }
                const shouldReclaim = options.shouldReclaim ?? defaultShouldReclaim;
                if (await shouldReclaim({
                    lockPath,
                    normalizedTargetPath,
                    payload: snapshot?.payload ?? null,
                    staleMs: options.staleMs,
                    nowMs,
                    heldByThisProcess: state.held.has(normalizedTargetPath),
                })) {
                    if (!(await lockSnapshotStillPresent(lockPath, snapshot))) {
                        continue;
                    }
                    const staleRecovery = options.staleRecovery ?? "fail-closed";
                    if (staleRecovery === "remove-if-unchanged") {
                        const removal = await removeStaleLockIfAllowed({
                            lockPath,
                            normalizedTargetPath,
                            snapshot,
                            shouldRemoveStaleLock: options.shouldRemoveStaleLock,
                        });
                        if (removal === "removed" || removal === "changed") {
                            continue;
                        }
                    }
                    throw Object.assign(new Error(`file lock stale for ${normalizedTargetPath}`), {
                        code: "file_lock_stale",
                        lockPath,
                        normalizedTargetPath,
                    });
                }
                const elapsed = Date.now() - startedAt;
                if ((options.timeoutMs !== undefined &&
                    options.timeoutMs !== Number.POSITIVE_INFINITY &&
                    elapsed >= options.timeoutMs) ||
                    (maxRetries !== undefined && attempt >= maxRetries)) {
                    throw Object.assign(new Error(`file lock timeout for ${normalizedTargetPath}`), {
                        code: "file_lock_timeout",
                        lockPath,
                        normalizedTargetPath,
                    });
                }
                const remaining = options.timeoutMs === undefined || options.timeoutMs === Number.POSITIVE_INFINITY
                    ? Number.POSITIVE_INFINITY
                    : Math.max(0, options.timeoutMs - elapsed);
                const delay = Math.min(computeDelayMs(retry, attempt), remaining);
                attempt += 1;
                await new Promise((resolve) => setTimeout(resolve, delay));
            }
        }
    }
    async function withLock(options, fn) {
        const lock = await acquire(options);
        try {
            return await fn();
        }
        finally {
            await lock.release();
        }
    }
    async function drain() {
        for (const [normalizedTargetPath, held] of Array.from(state.held.entries())) {
            await releaseHeldLock(state, normalizedTargetPath, held, { force: true }).catch(() => undefined);
        }
    }
    function reset() {
        releaseAllLocksSync(state);
    }
    function heldEntries() {
        return Array.from(state.held.entries()).map(([normalizedTargetPath, held]) => ({
            normalizedTargetPath,
            lockPath: held.lockPath,
            acquiredAt: held.acquiredAt,
            metadata: held.metadata,
            forceRelease: () => releaseHeldLock(state, normalizedTargetPath, held, { force: true }),
        }));
    }
    return { acquire, withLock, drain, reset, heldEntries };
}
export async function withSidecarLock(targetPath, options, fn) {
    const manager = createSidecarLockManager(options.managerKey ?? `fs-safe.sidecar-lock:${targetPath}`);
    const { managerKey: _managerKey, ...acquireOptions } = options;
    return await manager.withLock({ ...acquireOptions, targetPath }, fn);
}
