import { randomUUID } from "node:crypto";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { fileStore, fileStoreSync, } from "./file-store.js";
import { openRootFileSync } from "./root-file.js";
import { registerTempPathForExit } from "./temp-cleanup.js";
function sanitizeTempPrefix(prefix) {
    const sanitized = prefix.trim().replace(/[^a-zA-Z0-9._-]/g, "-");
    if (!sanitized || sanitized === "." || sanitized === "..") {
        return "fs-safe-";
    }
    return sanitized.endsWith("-") ? sanitized : `${sanitized}-`;
}
function resolveWorkspaceLeaf(dir, fileName) {
    return path.join(dir, assertWorkspaceFileName(fileName));
}
function assertWorkspaceFileName(fileName) {
    const value = fileName.trim();
    if (!value ||
        value === "." ||
        value === ".." ||
        value.includes("\0") ||
        value.includes("/") ||
        value.includes("\\") ||
        path.basename(value) !== value) {
        throw new Error(`Invalid temp workspace file name: ${JSON.stringify(fileName)}`);
    }
    return value;
}
async function ensurePrivateDirectory(dir, mode) {
    await fs.mkdir(dir, { recursive: true, mode });
    const stat = await fs.stat(dir);
    if (!stat.isDirectory()) {
        throw new Error(`Temp root must be a directory: ${dir}`);
    }
    await fs.chmod(dir, mode).catch(() => undefined);
}
function ensurePrivateDirectorySync(dir, mode) {
    fsSync.mkdirSync(dir, { recursive: true, mode });
    const stat = fsSync.statSync(dir);
    if (!stat.isDirectory()) {
        throw new Error(`Temp root must be a directory: ${dir}`);
    }
    try {
        fsSync.chmodSync(dir, mode);
    }
    catch {
        // Best-effort on platforms that do not enforce POSIX modes.
    }
}
async function createTempWorkspace(options) {
    const dirMode = options.dirMode ?? 0o700;
    const mode = options.mode ?? 0o600;
    const requestedRoot = path.resolve(options.rootDir);
    const root = await fs.realpath(requestedRoot).catch(() => requestedRoot);
    await ensurePrivateDirectory(root, dirMode);
    const dir = await fs.mkdtemp(path.join(root, sanitizeTempPrefix(options.prefix)));
    const unregisterTempDir = registerTempPathForExit(dir, { recursive: true });
    await fs.chmod(dir, dirMode).catch(() => undefined);
    const stat = await fs.lstat(dir);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
        throw new Error(`Temp workspace must be a directory: ${dir}`);
    }
    const store = fileStore({ rootDir: dir, private: true, dirMode, mode });
    return {
        dir,
        store,
        path: (fileName) => resolveWorkspaceLeaf(dir, fileName),
        write: async (fileName, data) => await store.write(assertWorkspaceFileName(fileName), data, { mode }),
        writeText: async (fileName, data) => await store.writeText(assertWorkspaceFileName(fileName), data, { mode }),
        writeJson: async (fileName, data, writeOptions) => await store.writeJson(assertWorkspaceFileName(fileName), data, {
            mode,
            trailingNewline: writeOptions?.trailingNewline,
        }),
        copyIn: async (fileName, sourcePath) => await store.copyIn(assertWorkspaceFileName(fileName), sourcePath, { mode }),
        read: async (fileName) => await store.readBytes(assertWorkspaceFileName(fileName)),
        cleanup: async () => {
            try {
                await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
            }
            finally {
                unregisterTempDir();
            }
        },
        [Symbol.asyncDispose]: async () => {
            try {
                await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
            }
            finally {
                unregisterTempDir();
            }
        },
    };
}
export async function tempWorkspace(options) {
    return await createTempWorkspace(options);
}
export async function withTempWorkspace(options, run) {
    const workspace = await createTempWorkspace({
        ...options,
        prefix: `${sanitizeTempPrefix(options.prefix)}${randomUUID()}-`,
    });
    try {
        return await run(workspace);
    }
    finally {
        await workspace.cleanup();
    }
}
export function tempWorkspaceSync(options) {
    const dirMode = options.dirMode ?? 0o700;
    const mode = options.mode ?? 0o600;
    const requestedRoot = path.resolve(options.rootDir);
    let root = requestedRoot;
    try {
        root = fsSync.realpathSync.native(requestedRoot);
    }
    catch {
        root = requestedRoot;
    }
    ensurePrivateDirectorySync(root, dirMode);
    const dir = fsSync.mkdtempSync(path.join(root, sanitizeTempPrefix(options.prefix)));
    const unregisterTempDir = registerTempPathForExit(dir, { recursive: true });
    try {
        fsSync.chmodSync(dir, dirMode);
    }
    catch {
        // Best-effort on platforms that do not enforce POSIX modes.
    }
    const stat = fsSync.lstatSync(dir);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
        throw new Error(`Temp workspace must be a directory: ${dir}`);
    }
    const store = fileStoreSync({ rootDir: dir, private: true, dirMode, mode });
    return {
        dir,
        store,
        path: (fileName) => resolveWorkspaceLeaf(dir, fileName),
        write: (fileName, data) => store.write(assertWorkspaceFileName(fileName), data, { mode }),
        writeText: (fileName, data) => store.writeText(assertWorkspaceFileName(fileName), data, { mode }),
        writeJson: (fileName, data, writeOptions) => store.writeJson(assertWorkspaceFileName(fileName), data, {
            mode,
            trailingNewline: writeOptions?.trailingNewline,
        }),
        read: (fileName) => {
            const opened = openRootFileSync({
                absolutePath: store.path(assertWorkspaceFileName(fileName)),
                rootPath: dir,
                boundaryLabel: "temp workspace",
                rejectHardlinks: true,
            });
            if (!opened.ok) {
                throw Object.assign(new Error(`File not found: ${fileName}`), { code: "ENOENT" });
            }
            try {
                return fsSync.readFileSync(opened.fd);
            }
            finally {
                fsSync.closeSync(opened.fd);
            }
        },
        cleanup: () => {
            try {
                fsSync.rmSync(dir, { recursive: true, force: true });
            }
            catch {
                // Best-effort cleanup.
            }
            finally {
                unregisterTempDir();
            }
        },
        [Symbol.dispose]: () => {
            try {
                fsSync.rmSync(dir, { recursive: true, force: true });
            }
            catch {
                // Best-effort cleanup.
            }
            finally {
                unregisterTempDir();
            }
        },
    };
}
export function withTempWorkspaceSync(options, run) {
    const workspace = tempWorkspaceSync({
        ...options,
        prefix: `${sanitizeTempPrefix(options.prefix)}${randomUUID()}-`,
    });
    try {
        return run(workspace);
    }
    finally {
        workspace.cleanup();
    }
}
