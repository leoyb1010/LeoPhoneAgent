import syncFs from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { assertSyncDirectoryGuard as assertDirectoryGuardSync, createSyncDirectoryGuard, } from "./directory-guard.js";
import { FsSafeError } from "./errors.js";
import { isPathInside, isPathRelativeEscape } from "./path.js";
import { resolveOpenedFileRealPathForHandle, root } from "./root.js";
import { resolveSecureTempRoot } from "./secure-temp-dir.js";
function parentRelativePath(relativePath) {
    const parent = path.posix.dirname(relativePath);
    return parent === "." ? "" : parent;
}
export async function ensureParentInRoot(scopedRoot, relativePath, mode) {
    const parent = parentRelativePath(relativePath);
    if (!parent) {
        return;
    }
    await scopedRoot.mkdir(parent);
    await chmodDirectoryInRootBestEffort(scopedRoot, parent, mode).catch(() => undefined);
}
export async function openWritableStoreRoot(params) {
    await fs.mkdir(params.rootDir, { recursive: true, mode: params.dirMode });
    await fs.chmod(params.rootDir, params.dirMode).catch(() => undefined);
    return await root(params.rootDir, { hardlinks: "reject", maxBytes: params.maxBytes });
}
async function chmodDirectoryInRootBestEffort(scopedRoot, relativePath, mode) {
    const dirPath = await scopedRoot.resolve(relativePath);
    const directoryFlag = "O_DIRECTORY" in syncFs.constants ? syncFs.constants.O_DIRECTORY : 0;
    const noFollowFlag = process.platform !== "win32" && "O_NOFOLLOW" in syncFs.constants
        ? syncFs.constants.O_NOFOLLOW
        : 0;
    const handle = await fs.open(dirPath, syncFs.constants.O_RDONLY | directoryFlag | noFollowFlag);
    try {
        const stat = await handle.stat();
        if (!stat.isDirectory()) {
            return;
        }
        const realPath = await resolveOpenedFileRealPathForHandle(handle, dirPath);
        if (!isPathInside(scopedRoot.rootWithSep, realPath)) {
            throw new FsSafeError("outside-workspace", "directory is outside store root");
        }
        await handle.chmod(mode).catch(() => undefined);
    }
    finally {
        await handle.close().catch(() => undefined);
    }
}
function createMaxBytesTransform(maxBytes) {
    if (maxBytes === undefined) {
        return undefined;
    }
    let total = 0;
    return new Transform({
        transform(chunk, _encoding, callback) {
            const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            total += buffer.byteLength;
            if (total > maxBytes) {
                callback(new FsSafeError("too-large", `file exceeds maximum size of ${maxBytes} bytes`));
                return;
            }
            callback(null, buffer);
        },
    });
}
export async function writeStreamToTempSource(params) {
    const tempRoot = resolveSecureTempRoot({
        fallbackPrefix: "fs-safe-file-store",
        unsafeFallbackLabel: "file store temp dir",
        warn: () => undefined,
    });
    const dir = await fs.mkdtemp(path.join(tempRoot, "fs-safe-file-store-"));
    const filePath = path.join(dir, "payload");
    let handle = null;
    let handleClosedByStream = false;
    try {
        handle = await fs.open(filePath, "wx", params.mode);
        const writable = handle.createWriteStream();
        writable.once("close", () => {
            handleClosedByStream = true;
        });
        const limiter = createMaxBytesTransform(params.maxBytes);
        if (limiter) {
            await pipeline(params.stream, limiter, writable);
        }
        else {
            await pipeline(params.stream, writable);
        }
        if (!handleClosedByStream) {
            await handle.close().catch(() => undefined);
        }
        await fs.chmod(filePath, params.mode).catch(() => undefined);
        return {
            path: filePath,
            cleanup: async () => {
                await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
            },
        };
    }
    catch (err) {
        if (handle && !handleClosedByStream) {
            await handle.close().catch(() => undefined);
        }
        await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
        throw err;
    }
}
export function assertSyncDirectoryGuard(guard) {
    try {
        assertDirectoryGuardSync(guard);
    }
    catch (error) {
        if (error instanceof FsSafeError && error.code === "path-mismatch") {
            throw new FsSafeError("path-mismatch", "store directory changed during write", {
                cause: error,
            });
        }
        throw error;
    }
}
function chmodDirectorySyncBestEffort(dir, mode) {
    try {
        syncFs.chmodSync(dir, mode);
    }
    catch {
        // Best-effort on platforms that do not enforce POSIX modes.
    }
}
export function ensureParentSync(params) {
    const rootDir = path.resolve(params.rootDir);
    const dir = path.dirname(path.resolve(params.filePath));
    const relative = path.relative(rootDir, dir);
    if (isPathRelativeEscape(relative)) {
        throw new FsSafeError("outside-workspace", "file path escapes store root");
    }
    syncFs.mkdirSync(rootDir, { recursive: true, mode: params.mode });
    const rootStat = syncFs.lstatSync(rootDir);
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
        throw new FsSafeError("not-file", `store root must be a directory: ${rootDir}`);
    }
    const rootReal = syncFs.realpathSync(rootDir);
    chmodDirectorySyncBestEffort(rootDir, params.mode);
    let current = rootDir;
    for (const segment of path.relative(rootDir, dir).split(path.sep).filter(Boolean)) {
        current = path.join(current, segment);
        try {
            const stat = syncFs.lstatSync(current);
            if (stat.isSymbolicLink() || !stat.isDirectory()) {
                throw new FsSafeError("not-file", `store directory component must be a directory: ${current}`);
            }
        }
        catch (error) {
            if (error.code !== "ENOENT") {
                throw error;
            }
            syncFs.mkdirSync(current, { mode: params.mode });
        }
        const currentReal = syncFs.realpathSync(current);
        if (!isPathInside(rootReal, currentReal)) {
            throw new FsSafeError("outside-workspace", "store directory escapes root");
        }
        chmodDirectorySyncBestEffort(current, params.mode);
    }
    const guard = createSyncDirectoryGuard(dir);
    assertSyncDirectoryGuard(guard);
    return guard;
}
