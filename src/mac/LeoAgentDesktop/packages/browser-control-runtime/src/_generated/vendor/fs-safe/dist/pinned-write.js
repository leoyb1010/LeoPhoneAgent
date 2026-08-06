import { randomUUID } from "node:crypto";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { createAsyncDirectoryGuard, createNearestExistingDirectoryGuard } from "./directory-guard.js";
import { FsSafeError } from "./errors.js";
import { syncDirectoryBestEffort } from "./fsync.js";
import { sameFileIdentity } from "./file-identity.js";
import { withAsyncDirectoryGuards } from "./guarded-mutation.js";
import { mkdirPathComponentsWithGuards } from "./guarded-mkdir.js";
import { canFallbackFromPythonError, getFsSafePythonConfig } from "./pinned-python-config.js";
import { assertPinnedPythonOperationAvailable, runPinnedPythonOperation, validatePinnedOperationPayload, } from "./pinned-python.js";
function byteLength(input, encoding) {
    return typeof input === "string"
        ? Buffer.byteLength(input, encoding ?? "utf8")
        : input.byteLength;
}
function assertSafeBasename(basename) {
    if (!basename ||
        basename === "." ||
        basename === ".." ||
        basename.includes("/") ||
        basename.includes("\0")) {
        throw new FsSafeError("invalid-path", "invalid target path");
    }
}
function assertWithinMaxBytes(bytes, maxBytes) {
    if (maxBytes !== undefined && bytes > maxBytes) {
        throw new FsSafeError("too-large", `file exceeds limit of ${maxBytes} bytes (got at least ${bytes})`);
    }
}
async function writeStreamToHandle(stream, handle, maxBytes) {
    let bytes = 0;
    for await (const chunk of stream) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        bytes += buffer.byteLength;
        assertWithinMaxBytes(bytes, maxBytes);
        let offset = 0;
        while (offset < buffer.byteLength) {
            const { bytesWritten } = await handle.write(buffer, offset, buffer.byteLength - offset);
            if (bytesWritten <= 0) {
                throw new FsSafeError("helper-failed", "fallback stream write made no progress");
            }
            offset += bytesWritten;
        }
    }
}
async function inputToBase64(input, maxBytes) {
    if (input.kind === "buffer") {
        assertWithinMaxBytes(byteLength(input.data, input.encoding), maxBytes);
        return (typeof input.data === "string"
            ? Buffer.from(input.data, input.encoding ?? "utf8")
            : input.data).toString("base64");
    }
    const chunks = [];
    let bytes = 0;
    for await (const chunk of input.stream) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        bytes += buffer.byteLength;
        assertWithinMaxBytes(bytes, maxBytes);
        chunks.push(buffer);
    }
    return Buffer.concat(chunks, bytes).toString("base64");
}
export async function runPinnedWriteHelper(params) {
    assertSafeBasename(params.basename);
    validatePinnedOperationPayload({
        relativeParentPath: params.relativeParentPath,
    });
    if (getFsSafePythonConfig().mode === "off") {
        return await runPinnedWriteFallback(params);
    }
    if (params.input.kind === "stream") {
        try {
            assertPinnedPythonOperationAvailable();
        }
        catch (error) {
            if (canFallbackFromPythonError(error)) {
                return await runPinnedWriteFallback(params);
            }
            throw error;
        }
    }
    const payload = {
        base64: await inputToBase64(params.input, params.maxBytes),
        basename: params.basename,
        maxBytes: params.maxBytes ?? -1,
        mkdir: params.mkdir,
        mode: params.mode || 0o600,
        overwrite: params.overwrite !== false,
        relativeParentPath: params.relativeParentPath,
        ...(params.rootIdentity ? { rootDev: params.rootIdentity.dev, rootIno: params.rootIdentity.ino } : {}),
    };
    try {
        return await runPinnedPythonOperation({
            operation: "write",
            rootPath: params.rootPath,
            payload,
        });
    }
    catch (error) {
        if (canFallbackFromPythonError(error)) {
            return await runPinnedWriteFallback(params);
        }
        throw error;
    }
}
export async function runPinnedCopyHelper(params) {
    assertSafeBasename(params.basename);
    validatePinnedOperationPayload({
        relativeParentPath: params.relativeParentPath,
    });
    return await runPinnedPythonOperation({
        operation: "copy",
        rootPath: params.rootPath,
        payload: {
            basename: params.basename,
            maxBytes: params.maxBytes ?? -1,
            mkdir: params.mkdir,
            mode: params.mode || 0o600,
            overwrite: params.overwrite !== false,
            relativeParentPath: params.relativeParentPath,
            ...(params.rootIdentity ? { rootDev: params.rootIdentity.dev, rootIno: params.rootIdentity.ino } : {}),
            sourceDev: params.sourceIdentity.dev,
            sourceIno: params.sourceIdentity.ino,
            sourcePath: params.sourcePath,
        },
    });
}
async function runPinnedWriteFallback(params) {
    const parentPath = params.relativeParentPath
        ? path.join(params.rootPath, ...params.relativeParentPath.split("/"))
        : params.rootPath;
    if (params.mkdir) {
        await mkdirPathComponentsWithGuards({ rootReal: params.rootPath, targetPath: parentPath });
    }
    const parentGuard = params.mkdir
        ? await createAsyncDirectoryGuard(parentPath)
        : await createNearestExistingDirectoryGuard(params.rootPath, parentPath);
    const targetPath = path.join(parentPath, params.basename);
    if (params.overwrite === false) {
        let handle = await withAsyncDirectoryGuards([parentGuard], async () => await fs.open(targetPath, fsSync.constants.O_WRONLY | fsSync.constants.O_CREAT | fsSync.constants.O_EXCL, params.mode), {
            onPostGuardFailure: async (openedHandle) => {
                // The parent failed verification, so targetPath may now resolve
                // somewhere else. Close the fd, but do not clean up by path.
                await openedHandle.close().catch(() => undefined);
            },
        });
        let created = true;
        try {
            if (params.input.kind === "buffer") {
                assertWithinMaxBytes(byteLength(params.input.data, params.input.encoding), params.maxBytes);
                if (typeof params.input.data === "string") {
                    await handle.writeFile(params.input.data, params.input.encoding ?? "utf8");
                }
                else {
                    await handle.writeFile(params.input.data);
                }
            }
            else {
                await writeStreamToHandle(params.input.stream, handle, params.maxBytes);
            }
            const stat = await handle.stat();
            created = false;
            return { dev: stat.dev, ino: stat.ino };
        }
        finally {
            await handle.close().catch(() => undefined);
            if (created) {
                await fs.rm(targetPath, { force: true }).catch(() => undefined);
            }
        }
    }
    const tempPath = path.join(parentPath, `.${params.basename}.${randomUUID()}.fallback.tmp`);
    const tempFlags = fsSync.constants.O_WRONLY |
        fsSync.constants.O_CREAT |
        fsSync.constants.O_EXCL |
        (process.platform !== "win32" && "O_NOFOLLOW" in fsSync.constants
            ? fsSync.constants.O_NOFOLLOW
            : 0);
    let handle;
    let tempStat;
    let targetStat;
    let renamed = false;
    try {
        handle = await fs.open(tempPath, tempFlags, params.mode);
        if (params.input.kind === "buffer") {
            assertWithinMaxBytes(byteLength(params.input.data, params.input.encoding), params.maxBytes);
            if (typeof params.input.data === "string") {
                await handle.writeFile(params.input.data, params.input.encoding ?? "utf8");
            }
            else {
                await handle.writeFile(params.input.data);
            }
        }
        else {
            await writeStreamToHandle(params.input.stream, handle, params.maxBytes);
        }
        tempStat = await handle.stat();
        const tempPathStat = await fs.lstat(tempPath);
        if (tempPathStat.isSymbolicLink() || !sameFileIdentity(tempPathStat, tempStat)) {
            throw new FsSafeError("path-mismatch", "fallback temp path changed during write");
        }
        const expectedTempStat = tempStat;
        await handle.sync();
        await handle.close().catch(() => undefined);
        handle = undefined;
        await withAsyncDirectoryGuards([parentGuard], async () => {
            await fs.rename(tempPath, targetPath);
            renamed = true;
            await syncDirectoryBestEffort(parentPath);
            targetStat = await fs.lstat(targetPath);
            if (targetStat.isSymbolicLink() || !sameFileIdentity(targetStat, expectedTempStat)) {
                throw new FsSafeError("path-mismatch", "fallback target changed during write");
            }
        });
    }
    catch (error) {
        await handle?.close().catch(() => undefined);
        if (!renamed) {
            await fs.rm(tempPath, { force: true }).catch(() => undefined);
        }
        throw error;
    }
    if (!targetStat) {
        throw new FsSafeError("path-mismatch", "fallback target was not verified");
    }
    return { dev: targetStat.dev, ino: targetStat.ino };
}
