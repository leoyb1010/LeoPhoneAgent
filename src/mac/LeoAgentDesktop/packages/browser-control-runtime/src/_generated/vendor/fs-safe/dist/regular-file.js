import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { assertNoUnsafeDeviceReadPath } from "./device-path.js";
import { FsSafeError } from "./errors.js";
import { sameFileIdentity } from "./file-identity.js";
import { isNotFoundPathError } from "./path.js";
import { assertNoSymlinkParents, assertNoSymlinkParentsSync } from "./symlink-parents.js";
export function resolveRegularFileAppendFlags(constants = fsSync.constants) {
    const noFollow = constants.O_NOFOLLOW;
    return (constants.O_CREAT |
        constants.O_APPEND |
        constants.O_WRONLY |
        (typeof noFollow === "number" ? noFollow : 0));
}
function resolveRegularFileReadFlags() {
    return (fsSync.constants.O_RDONLY |
        (typeof fsSync.constants.O_NOFOLLOW === "number" && process.platform !== "win32"
            ? fsSync.constants.O_NOFOLLOW
            : 0));
}
async function readFileHandleBounded(params) {
    if (params.maxBytes === undefined) {
        return await params.handle.readFile();
    }
    const chunks = [];
    const scratch = Buffer.allocUnsafe(Math.min(64 * 1024, Math.max(1, params.maxBytes + 1)));
    let total = 0;
    while (true) {
        const { bytesRead } = await params.handle.read(scratch, 0, scratch.length, null);
        if (bytesRead === 0) {
            return Buffer.concat(chunks, total);
        }
        total += bytesRead;
        if (total > params.maxBytes) {
            throw new Error(`File exceeds ${params.maxBytes} bytes: ${params.filePath}`);
        }
        chunks.push(Buffer.from(scratch.subarray(0, bytesRead)));
    }
}
function readFileDescriptorBounded(params) {
    if (params.maxBytes === undefined) {
        return fsSync.readFileSync(params.fd);
    }
    const chunks = [];
    const scratch = Buffer.allocUnsafe(Math.min(64 * 1024, Math.max(1, params.maxBytes + 1)));
    let total = 0;
    while (true) {
        const bytesRead = fsSync.readSync(params.fd, scratch, 0, scratch.length, null);
        if (bytesRead === 0) {
            return Buffer.concat(chunks, total);
        }
        total += bytesRead;
        if (total > params.maxBytes) {
            throw new Error(`File exceeds ${params.maxBytes} bytes: ${params.filePath}`);
        }
        chunks.push(Buffer.from(scratch.subarray(0, bytesRead)));
    }
}
export async function statRegularFile(filePath) {
    let stat;
    try {
        stat = await fs.lstat(filePath);
    }
    catch (err) {
        if (isNotFoundPathError(err)) {
            return { missing: true };
        }
        throw err;
    }
    if (stat.isSymbolicLink() || !stat.isFile()) {
        throw new Error("path must be a regular file");
    }
    return { missing: false, stat };
}
export function statRegularFileSync(filePath) {
    let stat;
    try {
        stat = fsSync.lstatSync(filePath);
    }
    catch (err) {
        if (isNotFoundPathError(err)) {
            return { missing: true };
        }
        throw err;
    }
    if (stat.isSymbolicLink() || !stat.isFile()) {
        throw new Error("path must be a regular file");
    }
    return { missing: false, stat };
}
export async function readRegularFile(params) {
    assertNoUnsafeDeviceReadPath(params.filePath);
    const result = await statRegularFile(params.filePath);
    if (result.missing) {
        throw Object.assign(new Error(`File not found: ${params.filePath}`), { code: "ENOENT" });
    }
    if (params.maxBytes !== undefined && result.stat.size > params.maxBytes) {
        throw new Error(`File exceeds ${params.maxBytes} bytes: ${params.filePath}`);
    }
    let handle;
    try {
        handle = await fs.open(params.filePath, resolveRegularFileReadFlags());
    }
    catch (err) {
        if (isNotFoundPathError(err)) {
            throw new FsSafeError("path-mismatch", `File changed during read: ${params.filePath}`);
        }
        throw err;
    }
    try {
        const stat = await handle.stat();
        let pathStat;
        try {
            pathStat = await fs.lstat(params.filePath);
        }
        catch (err) {
            if (isNotFoundPathError(err)) {
                throw new FsSafeError("path-mismatch", `File changed during read: ${params.filePath}`);
            }
            throw err;
        }
        verifyStableReadTarget({
            filePath: params.filePath,
            pathStat,
            postOpenStat: stat,
            preOpenStat: result.stat,
        });
        if (params.maxBytes !== undefined && stat.size > params.maxBytes) {
            throw new Error(`File exceeds ${params.maxBytes} bytes: ${params.filePath}`);
        }
        // With a byte cap, avoid readFile(): a raced file growth would allocate
        // the oversized content before the post-read check could reject it.
        const buffer = await readFileHandleBounded({
            handle,
            filePath: params.filePath,
            maxBytes: params.maxBytes,
        });
        return { buffer, stat };
    }
    finally {
        await handle.close();
    }
}
function verifyStableReadTarget(params) {
    if (!params.postOpenStat.isFile() || params.pathStat.isSymbolicLink() || !params.pathStat.isFile()) {
        throw new Error(`File is not a regular file: ${params.filePath}`);
    }
    if (!sameFileIdentity(params.preOpenStat, params.postOpenStat) ||
        !sameFileIdentity(params.pathStat, params.postOpenStat)) {
        throw new FsSafeError("path-mismatch", `File changed during read: ${params.filePath}`);
    }
}
function readOpenedRegularFileSync(params) {
    const stat = fsSync.fstatSync(params.fd);
    verifyStableReadTarget({
        filePath: params.filePath,
        pathStat: fsSync.lstatSync(params.filePath),
        postOpenStat: stat,
        preOpenStat: params.preOpenStat,
    });
    if (params.maxBytes !== undefined && stat.size > params.maxBytes) {
        throw new Error(`File exceeds ${params.maxBytes} bytes: ${params.filePath}`);
    }
    // Keep capped sync reads incremental for the same reason as async reads:
    // readFileSync(fd) would buffer a raced oversized file before throwing.
    const buffer = readFileDescriptorBounded({
        fd: params.fd,
        filePath: params.filePath,
        maxBytes: params.maxBytes,
    });
    return { buffer, stat };
}
export function readRegularFileSync(params) {
    assertNoUnsafeDeviceReadPath(params.filePath);
    const result = statRegularFileSync(params.filePath);
    if (result.missing) {
        throw Object.assign(new Error(`File not found: ${params.filePath}`), { code: "ENOENT" });
    }
    if (params.maxBytes !== undefined && result.stat.size > params.maxBytes) {
        throw new Error(`File exceeds ${params.maxBytes} bytes: ${params.filePath}`);
    }
    const fd = fsSync.openSync(params.filePath, resolveRegularFileReadFlags());
    try {
        return readOpenedRegularFileSync({
            fd,
            filePath: params.filePath,
            preOpenStat: result.stat,
            maxBytes: params.maxBytes,
        });
    }
    finally {
        fsSync.closeSync(fd);
    }
}
function verifyStableAppendTarget(params) {
    if (!params.postOpenStat.isFile()) {
        throw new Error(`Refusing to append to non-file: ${params.filePath}`);
    }
    if (params.postOpenStat.nlink > 1) {
        throw new Error(`Refusing to append to hardlinked file: ${params.filePath}`);
    }
    const pre = params.preOpenStat;
    if (pre && (pre.dev !== params.postOpenStat.dev || pre.ino !== params.postOpenStat.ino)) {
        throw new Error(`Refusing to append after file changed: ${params.filePath}`);
    }
}
export async function appendRegularFile(options) {
    if (options.rejectSymlinkParents === true) {
        const resolvedDir = path.resolve(path.dirname(options.filePath));
        await assertNoSymlinkParents({
            rootDir: path.parse(resolvedDir).root,
            targetPath: resolvedDir,
            allowMissing: false,
            allowRootChildSymlink: true,
            requireDirectories: true,
            messagePrefix: "Refusing to append under",
        });
    }
    let preOpenStat;
    try {
        const stat = await fs.lstat(options.filePath);
        if (stat.isSymbolicLink()) {
            throw new Error(`Refusing to append through symlink: ${options.filePath}`);
        }
        if (!stat.isFile()) {
            throw new Error(`Refusing to append to non-file: ${options.filePath}`);
        }
        preOpenStat = stat;
    }
    catch (err) {
        if (!isNotFoundPathError(err)) {
            throw err;
        }
    }
    const contentBytes = Buffer.isBuffer(options.content)
        ? options.content.byteLength
        : Buffer.byteLength(options.content, options.encoding ?? "utf8");
    if (options.maxFileBytes !== undefined &&
        (preOpenStat?.size ?? 0) + contentBytes > options.maxFileBytes) {
        return;
    }
    const handle = await fs.open(options.filePath, resolveRegularFileAppendFlags(), options.mode ?? 0o600);
    try {
        const stat = await handle.stat();
        verifyStableAppendTarget({ preOpenStat, postOpenStat: stat, filePath: options.filePath });
        if (options.maxFileBytes !== undefined && stat.size + contentBytes > options.maxFileBytes) {
            return;
        }
        await handle.chmod(options.mode ?? 0o600);
        await handle.appendFile(options.content, options.encoding ?? "utf8");
    }
    finally {
        await handle.close();
    }
}
export function appendRegularFileSync(options) {
    if (options.rejectSymlinkParents === true) {
        const resolvedDir = path.resolve(path.dirname(options.filePath));
        assertNoSymlinkParentsSync({
            rootDir: path.parse(resolvedDir).root,
            targetPath: resolvedDir,
            allowMissing: false,
            allowRootChildSymlink: true,
            requireDirectories: true,
            messagePrefix: "Refusing to append under",
        });
    }
    let preOpenStat;
    try {
        const stat = fsSync.lstatSync(options.filePath);
        if (stat.isSymbolicLink()) {
            throw new Error(`Refusing to append through symlink: ${options.filePath}`);
        }
        if (!stat.isFile()) {
            throw new Error(`Refusing to append to non-file: ${options.filePath}`);
        }
        preOpenStat = stat;
    }
    catch (err) {
        if (!isNotFoundPathError(err)) {
            throw err;
        }
    }
    const contentBuffer = typeof options.content === "string"
        ? Buffer.from(options.content, options.encoding ?? "utf8")
        : Buffer.from(options.content);
    if (options.maxFileBytes !== undefined &&
        (preOpenStat?.size ?? 0) + contentBuffer.byteLength > options.maxFileBytes) {
        return;
    }
    const fd = fsSync.openSync(options.filePath, resolveRegularFileAppendFlags(), options.mode ?? 0o600);
    try {
        const stat = fsSync.fstatSync(fd);
        verifyStableAppendTarget({ preOpenStat, postOpenStat: stat, filePath: options.filePath });
        if (options.maxFileBytes !== undefined &&
            stat.size + contentBuffer.byteLength > options.maxFileBytes) {
            return;
        }
        fsSync.fchmodSync(fd, options.mode ?? 0o600);
        fsSync.writeSync(fd, contentBuffer, 0, contentBuffer.byteLength);
    }
    finally {
        fsSync.closeSync(fd);
    }
}
