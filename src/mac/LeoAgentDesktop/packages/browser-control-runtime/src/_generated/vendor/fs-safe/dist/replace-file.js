import { randomUUID } from "node:crypto";
import syncFs from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { assertSafePathPrefix } from "./safe-path-segment.js";
import { registerTempPathForExit } from "./temp-cleanup.js";
import { serializePathWrite } from "./write-queue.js";
function isRetryableRenameError(error) {
    return error.code === "EBUSY";
}
function isPermissionRenameError(error) {
    const code = error.code;
    return code === "EPERM" || code === "EEXIST";
}
const SUPPORTS_NOFOLLOW = process.platform !== "win32" && "O_NOFOLLOW" in syncFs.constants;
const OPEN_READ_FLAGS = syncFs.constants.O_RDONLY | (SUPPORTS_NOFOLLOW ? syncFs.constants.O_NOFOLLOW : 0);
const OPEN_WRITE_EXCLUSIVE_FLAGS = syncFs.constants.O_WRONLY |
    syncFs.constants.O_CREAT |
    syncFs.constants.O_EXCL |
    (SUPPORTS_NOFOLLOW ? syncFs.constants.O_NOFOLLOW : 0);
async function sleep(ms) {
    await new Promise((resolve) => setTimeout(resolve, ms));
}
async function renameWithRetry(params) {
    for (let attempt = 0; attempt <= params.maxRetries; attempt++) {
        try {
            await params.fsModule.rename(params.src, params.dest);
            return { method: "rename" };
        }
        catch (error) {
            if (isRetryableRenameError(error) && attempt < params.maxRetries) {
                await sleep(params.baseDelayMs * 2 ** attempt);
                continue;
            }
            if (params.copyFallbackOnPermissionError && isPermissionRenameError(error)) {
                await copyFallbackReplace(params.fsModule, params.src, params.dest);
                return { method: "copy-fallback" };
            }
            throw error;
        }
    }
    throw new Error("Atomic rename retry loop exhausted.");
}
function sleepSync(ms) {
    if (ms <= 0) {
        return;
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
function renameWithRetrySync(params) {
    for (let attempt = 0; attempt <= params.maxRetries; attempt++) {
        try {
            params.fsModule.renameSync(params.src, params.dest);
            return { method: "rename" };
        }
        catch (error) {
            if (isRetryableRenameError(error) && attempt < params.maxRetries) {
                sleepSync(params.baseDelayMs * 2 ** attempt);
                continue;
            }
            if (params.copyFallbackOnPermissionError && isPermissionRenameError(error)) {
                copyFallbackReplaceSync(params.fsModule, params.src, params.dest);
                return { method: "copy-fallback" };
            }
            throw error;
        }
    }
    throw new Error("Atomic rename retry loop exhausted.");
}
async function copyFallbackReplace(fsModule, src, dest) {
    const sourceStat = await fsModule.lstat(src);
    if (sourceStat.isSymbolicLink() || !sourceStat.isFile()) {
        throw new Error(`Refusing copy fallback from non-file source: ${src}`);
    }
    const destStat = await fsModule.lstat(dest).catch((lstatError) => {
        if (lstatError.code === "ENOENT") {
            return null;
        }
        throw lstatError;
    });
    if (destStat?.isSymbolicLink()) {
        throw new Error(`Refusing copy fallback through symlink destination: ${dest}`);
    }
    if (destStat) {
        await fsModule.rm(dest, { force: true });
    }
    let sourceHandle = null;
    let destHandle = null;
    try {
        sourceHandle = await fsModule.open(src, OPEN_READ_FLAGS);
        destHandle = await fsModule.open(dest, OPEN_WRITE_EXCLUSIVE_FLAGS, sourceStat.mode & 0o777);
        await destHandle.writeFile(await sourceHandle.readFile());
    }
    finally {
        await destHandle?.close().catch(() => undefined);
        await sourceHandle?.close().catch(() => undefined);
    }
    await fsModule.unlink(src).catch(() => undefined);
}
function copyFallbackReplaceSync(fsModule, src, dest) {
    const sourceStat = fsModule.lstatSync(src);
    if (sourceStat.isSymbolicLink() || !sourceStat.isFile()) {
        throw new Error(`Refusing copy fallback from non-file source: ${src}`);
    }
    let destStat = null;
    try {
        destStat = fsModule.lstatSync(dest);
    }
    catch (lstatError) {
        if (lstatError.code !== "ENOENT") {
            throw lstatError;
        }
    }
    if (destStat?.isSymbolicLink()) {
        throw new Error(`Refusing copy fallback through symlink destination: ${dest}`);
    }
    if (destStat) {
        fsModule.rmSync(dest, { force: true });
    }
    let sourceFd;
    let destFd;
    try {
        sourceFd = fsModule.openSync(src, OPEN_READ_FLAGS);
        destFd = fsModule.openSync(dest, OPEN_WRITE_EXCLUSIVE_FLAGS, sourceStat.mode & 0o777);
        fsModule.writeFileSync(destFd, fsModule.readFileSync(sourceFd));
    }
    finally {
        if (destFd !== undefined) {
            try {
                fsModule.closeSync(destFd);
            }
            catch {
                // Best-effort close after fallback replacement.
            }
        }
        if (sourceFd !== undefined) {
            try {
                fsModule.closeSync(sourceFd);
            }
            catch {
                // Best-effort close after fallback replacement.
            }
        }
    }
    try {
        fsModule.unlinkSync(src);
    }
    catch {
        // Best-effort cleanup after fallback replacement.
    }
}
function validateReplaceFilePath(filePath) {
    if (!filePath || filePath.includes("\0")) {
        throw new Error("Atomic replace file path must be non-empty.");
    }
}
function buildReplaceTempPath(filePath, tempPrefix) {
    const dir = path.dirname(filePath);
    const safePrefix = assertSafePathPrefix(tempPrefix ?? ".fs-safe-replace", { label: "atomic replace temp prefix" });
    return path.join(dir, `${safePrefix}.${process.pid}.${randomUUID()}.tmp`);
}
async function resolveMode(options) {
    const defaultMode = options.mode ?? 0o600;
    if (!options.preserveExistingMode) {
        return defaultMode;
    }
    const stat = await (options.fileSystem?.promises ?? fs).stat(options.filePath).catch((error) => {
        if (error.code === "ENOENT") {
            return null;
        }
        throw error;
    });
    return stat ? stat.mode : defaultMode;
}
function resolveModeSync(options) {
    const defaultMode = options.mode ?? 0o600;
    if (!options.preserveExistingMode) {
        return defaultMode;
    }
    const fsModule = options.fileSystem ?? syncFs;
    let stat;
    try {
        stat = fsModule.statSync(options.filePath);
    }
    catch (error) {
        if (error.code !== "ENOENT") {
            throw error;
        }
    }
    return stat ? stat.mode : defaultMode;
}
async function syncTempFile(fsModule, tempPath) {
    const handle = await fsModule.open(tempPath, "r+");
    try {
        await handle.sync();
    }
    catch (error) {
        if (error.code !== "EPERM") {
            throw error;
        }
    }
    finally {
        await handle.close();
    }
}
function syncTempFileSync(fsModule, tempPath) {
    const fd = fsModule.openSync(tempPath, "r+");
    try {
        fsModule.fsyncSync(fd);
    }
    catch (error) {
        if (error.code !== "EPERM") {
            throw error;
        }
    }
    finally {
        fsModule.closeSync(fd);
    }
}
async function syncDirectoryBestEffort(fsModule, dirPath) {
    let handle;
    try {
        handle = await fsModule.open(dirPath, "r");
        await handle.sync();
    }
    catch {
        // Best-effort on platforms/filesystems that do not support directory fsync.
    }
    finally {
        await handle?.close().catch(() => undefined);
    }
}
function syncDirectoryBestEffortSync(fsModule, dirPath) {
    let fd;
    try {
        fd = fsModule.openSync(dirPath, "r");
        fsModule.fsyncSync(fd);
    }
    catch {
        // Best-effort on platforms/filesystems that do not support directory fsync.
    }
    finally {
        if (fd !== undefined) {
            try {
                fsModule.closeSync(fd);
            }
            catch {
                // Best-effort close after directory fsync.
            }
        }
    }
}
async function cleanupTempFile(params) {
    const cleanupError = await params.fsModule
        .rm(params.tempPath, { force: true })
        .catch((error) => error);
    if (cleanupError && params.throwOnCleanupError && params.originalError !== undefined) {
        throw new Error(`Atomic file replace failed (${String(params.originalError)}); cleanup also failed (${String(cleanupError)})`, { cause: params.originalError });
    }
}
export async function replaceFileAtomic(options) {
    const filePath = options.filePath;
    validateReplaceFilePath(filePath);
    return await serializePathWrite(path.resolve(filePath), async () => {
        return await replaceFileAtomicUnserialized(options);
    });
}
async function replaceFileAtomicUnserialized(options) {
    const filePath = options.filePath;
    const fsModule = options.fileSystem?.promises ?? fs;
    const dir = path.dirname(filePath);
    const dirMode = options.dirMode ?? 0o700;
    const mode = await resolveMode(options);
    const tempPath = buildReplaceTempPath(filePath, options.tempPrefix);
    const unregisterTempPath = registerTempPathForExit(tempPath);
    let tempExists = false;
    let originalError;
    await fsModule.mkdir(dir, { recursive: true, mode: dirMode });
    await fsModule.chmod(dir, dirMode).catch(() => undefined);
    try {
        tempExists = true;
        await fsModule.writeFile(tempPath, options.content, { mode, flag: "wx" });
        if (options.syncTempFile) {
            await syncTempFile(fsModule, tempPath);
        }
        if (options.beforeRename) {
            await options.beforeRename({ filePath, tempPath });
        }
        const result = await renameWithRetry({
            fsModule,
            src: tempPath,
            dest: filePath,
            maxRetries: options.renameMaxRetries ?? 0,
            baseDelayMs: options.renameRetryBaseDelayMs ?? 50,
            copyFallbackOnPermissionError: options.copyFallbackOnPermissionError === true,
        });
        tempExists = false;
        unregisterTempPath();
        await fsModule.chmod(filePath, mode).catch(() => undefined);
        if (options.syncParentDir) {
            await syncDirectoryBestEffort(fsModule, dir);
        }
        return result;
    }
    catch (error) {
        originalError = error;
        throw error;
    }
    finally {
        if (tempExists) {
            await cleanupTempFile({
                fsModule,
                tempPath,
                originalError,
                throwOnCleanupError: options.throwOnCleanupError === true,
            });
        }
        unregisterTempPath();
    }
}
export function replaceFileAtomicSync(options) {
    const filePath = options.filePath;
    validateReplaceFilePath(filePath);
    const fsModule = options.fileSystem ?? syncFs;
    const dir = path.dirname(filePath);
    const dirMode = options.dirMode ?? 0o700;
    const mode = resolveModeSync(options);
    const tempPath = buildReplaceTempPath(filePath, options.tempPrefix);
    const unregisterTempPath = registerTempPathForExit(tempPath);
    let tempExists = false;
    let originalError;
    fsModule.mkdirSync(dir, { recursive: true, mode: dirMode });
    try {
        fsModule.chmodSync(dir, dirMode);
    }
    catch {
        // Best-effort on platforms that do not enforce POSIX modes.
    }
    try {
        tempExists = true;
        fsModule.writeFileSync(tempPath, options.content, { mode, flag: "wx" });
        if (options.syncTempFile) {
            syncTempFileSync(fsModule, tempPath);
        }
        if (options.beforeRename) {
            options.beforeRename({ filePath, tempPath });
        }
        const result = renameWithRetrySync({
            fsModule,
            src: tempPath,
            dest: filePath,
            maxRetries: options.renameMaxRetries ?? 0,
            baseDelayMs: options.renameRetryBaseDelayMs ?? 50,
            copyFallbackOnPermissionError: options.copyFallbackOnPermissionError === true,
        });
        tempExists = false;
        unregisterTempPath();
        try {
            fsModule.chmodSync(filePath, mode);
        }
        catch {
            // Best-effort on platforms that do not enforce POSIX modes.
        }
        if (options.syncParentDir) {
            syncDirectoryBestEffortSync(fsModule, dir);
        }
        return result;
    }
    catch (error) {
        originalError = error;
        throw error;
    }
    finally {
        if (tempExists) {
            try {
                fsModule.rmSync(tempPath, { force: true });
            }
            catch (cleanupError) {
                if (options.throwOnCleanupError && originalError !== undefined) {
                    throw new Error(`Atomic file replace failed (${String(originalError)}); cleanup also failed (${String(cleanupError)})`, { cause: originalError });
                }
                // The temp file is best-effort cleanup after write failure.
            }
        }
        unregisterTempPath();
    }
}
