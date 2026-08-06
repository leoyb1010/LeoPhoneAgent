import { randomUUID } from "node:crypto";
import syncFs from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { createSyncDirectoryGuard } from "./directory-guard.js";
import { FsSafeError } from "./errors.js";
import { pruneExpiredStoreEntries, } from "./file-store-prune.js";
import { assertSyncDirectoryGuard, ensureParentInRoot, ensureParentSync, openWritableStoreRoot, writeStreamToTempSource, } from "./file-store-boundary.js";
import { readFileStoreCopySource } from "./file-store-source.js";
import { createJsonStore } from "./json-document-store.js";
import { stringifyJsonDocument } from "./json-stringify.js";
import { isPathInside, resolveSafeRelativePath } from "./path.js";
import { root } from "./root.js";
import { DEFAULT_ROOT_MAX_BYTES } from "./root-impl.js";
import { matchRootFileOpenFailure, openRootFileSync } from "./root-file.js";
import { writeSecretFileAtomic } from "./secret-file.js";
import { getFsSafeTestHooks } from "./test-hooks.js";
function assertRelativePath(relativePath) {
    const raw = relativePath.trim();
    if (!raw) {
        throw new FsSafeError("invalid-path", "relative path must be non-empty");
    }
    return raw.replaceAll("\\", "/");
}
function resolveStorePath(rootDir, relativePath) {
    return resolveSafeRelativePath(rootDir, assertRelativePath(relativePath));
}
function assertStoreFilePath(rootDir, filePath) {
    if (!isPathInside(rootDir, filePath)) {
        throw new FsSafeError("outside-workspace", "file path escapes store root");
    }
}
function assertMaxBytes(size, maxBytes) {
    if (maxBytes !== undefined && size > maxBytes) {
        throw new FsSafeError("too-large", `file exceeds maximum size of ${maxBytes} bytes`);
    }
}
function isNotFound(error) {
    if (!error) {
        return false;
    }
    return error instanceof FsSafeError
        ? error.code === "not-found"
        : error.code === "ENOENT" ||
            error.code === "ENOTDIR";
}
function handleSyncStoreReadOpenFailure(opened) {
    return matchRootFileOpenFailure(opened, {
        path: (failure) => {
            if (isNotFound(failure.error)) {
                return null;
            }
            throw new FsSafeError("path-mismatch", "store target changed during read", {
                cause: failure.error instanceof Error ? failure.error : undefined,
            });
        },
        validation: (failure) => {
            // Validation failures mean the path existed but violated store policy
            // (directory, hardlink, symlink race). Do not report them as missing.
            throw new FsSafeError("path-mismatch", "store target failed read validation", {
                cause: failure.error instanceof Error ? failure.error : undefined,
            });
        },
        fallback: (failure) => {
            throw new FsSafeError("path-mismatch", "store target changed during read", {
                cause: failure.error instanceof Error ? failure.error : undefined,
            });
        },
    });
}
async function copyIntoRoot(params) {
    const relativePath = assertRelativePath(params.relativePath);
    const destination = resolveStorePath(params.rootDir, relativePath);
    const sourceStat = await fs.lstat(params.sourcePath);
    if (sourceStat.isSymbolicLink() || !sourceStat.isFile()) {
        throw new FsSafeError("not-file", "source path is not a file");
    }
    assertMaxBytes(sourceStat.size, params.maxBytes);
    const dirMode = params.dirMode ?? 0o700;
    const scopedRoot = await openWritableStoreRoot({
        rootDir: params.rootDir,
        dirMode,
        maxBytes: params.maxBytes,
    });
    await ensureParentInRoot(scopedRoot, relativePath, dirMode);
    await scopedRoot.copyIn(relativePath, params.sourcePath, {
        maxBytes: params.maxBytes,
        mkdir: false,
        mode: params.mode ?? 0o600,
    });
    return destination;
}
export function fileStore(options) {
    const rootDir = path.resolve(options.rootDir);
    const privateMode = options.private ?? false;
    const dirMode = options.dirMode ?? 0o700;
    const mode = options.mode ?? 0o600;
    const maxBytes = options.maxBytes;
    async function openRoot() {
        return await root(rootDir, { hardlinks: "reject", maxBytes });
    }
    async function write(relativePath, data, writeOptions) {
        const safeRelativePath = assertRelativePath(relativePath);
        const destination = resolveStorePath(rootDir, safeRelativePath);
        const content = Buffer.isBuffer(data) ? data : Buffer.from(data);
        assertMaxBytes(content.byteLength, writeOptions?.maxBytes ?? maxBytes);
        if (privateMode) {
            await writeSecretFileAtomic({
                rootDir,
                filePath: destination,
                content,
                dirMode: writeOptions?.dirMode ?? dirMode,
                mode: writeOptions?.mode ?? mode,
            });
            return destination;
        }
        const writeDirMode = writeOptions?.dirMode ?? dirMode;
        const scopedRoot = await openWritableStoreRoot({
            rootDir,
            dirMode: writeDirMode,
            maxBytes: writeOptions?.maxBytes ?? maxBytes,
        });
        await ensureParentInRoot(scopedRoot, safeRelativePath, writeDirMode);
        await scopedRoot.write(safeRelativePath, content, {
            mkdir: false,
            mode: writeOptions?.mode ?? mode,
        });
        return destination;
    }
    return {
        rootDir,
        path: (relativePath) => resolveStorePath(rootDir, relativePath),
        root: openRoot,
        write,
        writeStream: async (relativePath, stream, writeOptions) => {
            const safeRelativePath = assertRelativePath(relativePath);
            const destination = resolveStorePath(rootDir, safeRelativePath);
            const limit = writeOptions?.maxBytes ?? maxBytes ?? (privateMode ? DEFAULT_ROOT_MAX_BYTES : undefined);
            if (privateMode) {
                const chunks = [];
                let total = 0;
                for await (const chunk of stream) {
                    const buffer = typeof chunk === "string" ? Buffer.from(chunk) : Buffer.from(chunk);
                    total += buffer.byteLength;
                    assertMaxBytes(total, limit);
                    chunks.push(buffer);
                }
                await writeSecretFileAtomic({
                    rootDir,
                    filePath: destination,
                    content: Buffer.concat(chunks),
                    dirMode: writeOptions?.dirMode ?? dirMode,
                    mode: writeOptions?.mode ?? mode,
                });
                return destination;
            }
            const staged = await writeStreamToTempSource({
                stream,
                maxBytes: limit,
                mode: writeOptions?.mode ?? mode,
            });
            try {
                await copyIntoRoot({
                    rootDir,
                    relativePath: safeRelativePath,
                    sourcePath: staged.path,
                    maxBytes: limit,
                    mode: writeOptions?.mode ?? mode,
                    tempPrefix: writeOptions?.tempPrefix,
                    dirMode: writeOptions?.dirMode ?? dirMode,
                });
            }
            finally {
                await staged.cleanup();
            }
            return destination;
        },
        copyIn: async (relativePath, sourcePath, writeOptions) => privateMode
            ? await (async () => {
                const buffer = await readFileStoreCopySource({
                    sourcePath,
                    maxBytes: writeOptions?.maxBytes ?? maxBytes ?? DEFAULT_ROOT_MAX_BYTES,
                });
                return await write(relativePath, buffer, writeOptions);
            })()
            : await copyIntoRoot({
                rootDir,
                relativePath,
                sourcePath,
                dirMode: writeOptions?.dirMode ?? dirMode,
                maxBytes: writeOptions?.maxBytes ?? maxBytes,
                mode: writeOptions?.mode ?? mode,
                tempPrefix: writeOptions?.tempPrefix,
            }),
        open: async (relativePath, readOptions) => await (await openRoot()).open(assertRelativePath(relativePath), readOptions),
        read: async (relativePath, readOptions) => await (await openRoot()).read(assertRelativePath(relativePath), readOptions),
        readBytes: async (relativePath, readOptions) => await (await openRoot()).readBytes(assertRelativePath(relativePath), readOptions),
        readText: async (relativePath, readOptions) => {
            const { encoding = "utf8", ...options } = readOptions ?? {};
            return (await (await openRoot()).read(assertRelativePath(relativePath), options)).buffer
                .toString(encoding);
        },
        readTextIfExists: async (relativePath, readOptions) => {
            try {
                return await (await openRoot()).readText(assertRelativePath(relativePath), readOptions);
            }
            catch (error) {
                if (isNotFound(error)) {
                    return null;
                }
                throw error;
            }
        },
        readJson: async (relativePath, readOptions) => {
            const { encoding = "utf8", ...options } = readOptions ?? {};
            return JSON.parse((await (await openRoot()).read(assertRelativePath(relativePath), options)).buffer
                .toString(encoding));
        },
        readJsonIfExists: async (relativePath, readOptions) => {
            try {
                return await (await openRoot()).readJson(assertRelativePath(relativePath), readOptions);
            }
            catch (error) {
                if (isNotFound(error)) {
                    return null;
                }
                throw error;
            }
        },
        remove: async (relativePath) => {
            await (await openRoot()).remove(assertRelativePath(relativePath));
        },
        exists: async (relativePath) => await (await openRoot()).exists(assertRelativePath(relativePath)),
        writeText: async (relativePath, data, writeOptions) => await write(relativePath, data, writeOptions),
        writeJson: async (relativePath, data, writeOptions) => {
            const json = stringifyJsonDocument(data, null, 2);
            return await write(relativePath, writeOptions?.trailingNewline === false ? json : `${json}\n`, writeOptions);
        },
        json: (relativePath, jsonOptions) => {
            const filePath = resolveStorePath(rootDir, relativePath);
            return createJsonStore({
                filePath,
                readIfExists: async () => {
                    try {
                        return await (await openRoot()).readJson(assertRelativePath(relativePath));
                    }
                    catch (error) {
                        if (isNotFound(error)) {
                            return undefined;
                        }
                        throw error;
                    }
                },
                readRequired: async () => await (await openRoot()).readJson(assertRelativePath(relativePath)),
                write: async (value, options) => {
                    const json = stringifyJsonDocument(value, null, 2);
                    await write(relativePath, options?.trailingNewline === false ? json : `${json}\n`);
                },
            }, jsonOptions);
        },
        pruneExpired: async (pruneOptions) => {
            await pruneExpiredStoreEntries({ rootDir, dirMode, options: pruneOptions });
        },
    };
}
function ensurePrivateDirectorySync(rootDir, targetDir, mode) {
    const root = path.resolve(rootDir);
    const target = path.resolve(targetDir);
    assertStoreFilePath(root, target);
    let current = root;
    syncFs.mkdirSync(current, { recursive: true, mode });
    const rootStat = syncFs.lstatSync(current);
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
        throw new FsSafeError("not-file", `private store root must be a directory: ${current}`);
    }
    try {
        syncFs.chmodSync(current, mode);
    }
    catch {
        // Best-effort on platforms that do not enforce POSIX modes.
    }
    for (const segment of path.relative(root, target).split(path.sep).filter(Boolean)) {
        current = path.join(current, segment);
        try {
            const stat = syncFs.lstatSync(current);
            if (stat.isSymbolicLink() || !stat.isDirectory()) {
                throw new FsSafeError("not-file", `private store directory component must be a directory: ${current}`);
            }
        }
        catch (error) {
            if (error.code !== "ENOENT") {
                throw error;
            }
            syncFs.mkdirSync(current, { mode });
        }
        const rootReal = syncFs.realpathSync(root);
        const currentReal = syncFs.realpathSync(current);
        if (!isPathInside(rootReal, currentReal)) {
            throw new FsSafeError("outside-workspace", "private store directory escapes root");
        }
        try {
            syncFs.chmodSync(current, mode);
        }
        catch {
            // Best-effort on platforms that do not enforce POSIX modes.
        }
    }
    const guard = createSyncDirectoryGuard(target);
    assertSyncDirectoryGuard(guard);
    return guard;
}
function writeFileSyncAtomic(params) {
    const filePath = path.resolve(params.filePath);
    assertStoreFilePath(params.rootDir, filePath);
    let parentGuard;
    if (params.privateMode) {
        parentGuard = ensurePrivateDirectorySync(params.rootDir, path.dirname(filePath), params.dirMode);
        try {
            const stat = syncFs.lstatSync(filePath);
            if (stat.isSymbolicLink() || !stat.isFile()) {
                throw new FsSafeError("not-file", `private store target must be a regular file: ${filePath}`);
            }
        }
        catch (error) {
            if (error.code !== "ENOENT") {
                throw error;
            }
        }
    }
    else {
        parentGuard = ensureParentSync({
            rootDir: params.rootDir,
            filePath,
            mode: params.dirMode,
        });
    }
    const tempPath = path.join(parentGuard?.dir ?? path.dirname(filePath), `.fs-safe-${process.pid}-${randomUUID()}.tmp`);
    let tempExists = false;
    try {
        getFsSafeTestHooks()?.beforeFileStoreSyncPrivateWrite?.(filePath);
        if (parentGuard) {
            assertSyncDirectoryGuard(parentGuard);
        }
        syncFs.writeFileSync(tempPath, params.content, { flag: "wx", mode: params.mode });
        tempExists = true;
        try {
            syncFs.chmodSync(tempPath, params.mode);
        }
        catch {
            // Best-effort on platforms that do not enforce POSIX modes.
        }
        if (parentGuard) {
            assertSyncDirectoryGuard(parentGuard);
        }
        syncFs.renameSync(tempPath, filePath);
        tempExists = false;
        if (parentGuard) {
            assertSyncDirectoryGuard(parentGuard);
        }
        try {
            syncFs.chmodSync(filePath, params.mode);
        }
        catch {
            // Best-effort on platforms that do not enforce POSIX modes.
        }
        return filePath;
    }
    finally {
        if (tempExists) {
            try {
                syncFs.unlinkSync(tempPath);
            }
            catch {
                // Best-effort cleanup after write failure.
            }
        }
    }
}
export function fileStoreSync(options) {
    const rootDir = path.resolve(options.rootDir);
    const privateMode = options.private ?? false;
    const dirMode = options.dirMode ?? 0o700;
    const mode = options.mode ?? 0o600;
    const maxBytes = options.maxBytes;
    function write(relativePath, data, writeOptions) {
        const destination = resolveStorePath(rootDir, relativePath);
        const content = Buffer.isBuffer(data) ? data : Buffer.from(data);
        assertMaxBytes(content.byteLength, writeOptions?.maxBytes ?? maxBytes);
        return writeFileSyncAtomic({
            rootDir,
            filePath: destination,
            content,
            privateMode,
            dirMode: writeOptions?.dirMode ?? dirMode,
            mode: writeOptions?.mode ?? mode,
        });
    }
    return {
        rootDir,
        path: (relativePath) => resolveStorePath(rootDir, relativePath),
        readTextIfExists: (relativePath, readOptions) => {
            const targetPath = resolveStorePath(rootDir, relativePath);
            const opened = openRootFileSync({
                absolutePath: targetPath,
                rootPath: rootDir,
                boundaryLabel: "store root",
                rejectHardlinks: true,
            });
            if (!opened.ok) {
                return handleSyncStoreReadOpenFailure(opened);
            }
            try {
                assertMaxBytes(opened.stat.size, readOptions?.maxBytes ?? maxBytes);
                const raw = syncFs.readFileSync(opened.fd, "utf8");
                assertMaxBytes(Buffer.byteLength(raw, "utf8"), readOptions?.maxBytes ?? maxBytes);
                return raw;
            }
            finally {
                syncFs.closeSync(opened.fd);
            }
        },
        readJsonIfExists: (relativePath, readOptions) => {
            const raw = fileStoreSync({ rootDir, private: privateMode, dirMode, mode, maxBytes })
                .readTextIfExists(relativePath, readOptions);
            return raw === null ? null : JSON.parse(raw);
        },
        write,
        writeText: (relativePath, data, writeOptions) => write(relativePath, data, writeOptions),
        writeJson: (relativePath, data, writeOptions) => {
            const json = stringifyJsonDocument(data, null, 2);
            return write(relativePath, writeOptions?.trailingNewline === false ? json : `${json}\n`, writeOptions);
        },
    };
}
