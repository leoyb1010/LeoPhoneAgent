import { getFsSafeLockConfig } from "./lock-config.js";
import { createSidecarLockManager } from "./sidecar-lock.js";
function cloneFallback(value) {
    if (value && typeof value === "object") {
        return structuredClone(value);
    }
    return value;
}
function resolveLockOptions(filePath, options) {
    if (!options.lock) {
        return null;
    }
    const lockOptions = options.lock === true ? {} : options.lock;
    const defaults = getFsSafeLockConfig();
    return {
        managerKey: lockOptions.managerKey ?? `fs-safe.json-store:${filePath}`,
        retry: lockOptions.retry ?? defaults.retry ?? {},
        staleMs: lockOptions.staleMs ?? defaults.staleMs ?? 30_000,
        staleRecovery: lockOptions.staleRecovery ?? defaults.staleRecovery,
        timeoutMs: lockOptions.timeoutMs ?? defaults.timeoutMs ?? 30_000,
    };
}
export function createJsonStore(adapter, options = {}) {
    const lockOptions = resolveLockOptions(adapter.filePath, options);
    const locks = lockOptions ? createSidecarLockManager(lockOptions.managerKey) : null;
    async function read() {
        return await adapter.readIfExists();
    }
    async function readOr(fallback) {
        const current = await read();
        return current === undefined ? cloneFallback(fallback) : current;
    }
    async function write(value) {
        await adapter.write(value, {
            trailingNewline: options.trailingNewline ?? true,
        });
    }
    async function withOptionalLock(run) {
        if (!locks || !lockOptions) {
            return await run();
        }
        return await locks.withLock({
            targetPath: adapter.filePath,
            staleMs: lockOptions.staleMs,
            timeoutMs: lockOptions.timeoutMs,
            retry: lockOptions.retry,
            staleRecovery: lockOptions.staleRecovery,
            allowReentrant: true,
            payload: () => ({ pid: process.pid, createdAt: new Date().toISOString() }),
        }, run);
    }
    return {
        filePath: adapter.filePath,
        read,
        readOr,
        readRequired: adapter.readRequired,
        write: async (value) => {
            await withOptionalLock(async () => {
                await write(value);
            });
        },
        update: async (run) => await withOptionalLock(async () => {
            const next = await run(await read());
            await write(next);
            return next;
        }),
        updateOr: async (fallback, run) => await withOptionalLock(async () => {
            const current = await read();
            const next = await run(current === undefined ? cloneFallback(fallback) : current);
            await write(next);
            return next;
        }),
    };
}
