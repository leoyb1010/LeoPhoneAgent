import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { FsSafeError } from "./errors.js";
import { sameFileIdentity } from "./file-identity.js";
import { isNotFoundPathError } from "./path.js";
export async function createAsyncDirectoryGuard(dir) {
    const stat = await fs.lstat(dir);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
        throw new FsSafeError("not-file", "directory component must be a directory");
    }
    return { dir, realPath: await fs.realpath(dir), stat };
}
export async function assertAsyncDirectoryGuard(guard) {
    const stat = await fs.lstat(guard.dir);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
        throw new FsSafeError("not-file", "directory component must be a directory");
    }
    if (!sameFileIdentity(stat, guard.stat) || (await fs.realpath(guard.dir)) !== guard.realPath) {
        throw new FsSafeError("path-mismatch", "directory changed during operation");
    }
}
export function createSyncDirectoryGuard(dir) {
    const stat = fsSync.lstatSync(dir);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
        throw new FsSafeError("not-file", "directory component must be a directory");
    }
    return { dir, realPath: fsSync.realpathSync(dir), stat };
}
export function assertSyncDirectoryGuard(guard) {
    const stat = fsSync.lstatSync(guard.dir);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
        throw new FsSafeError("not-file", "directory component must be a directory");
    }
    if (!sameFileIdentity(stat, guard.stat) || fsSync.realpathSync(guard.dir) !== guard.realPath) {
        throw new FsSafeError("path-mismatch", "directory changed during operation");
    }
}
export async function createNearestExistingDirectoryGuard(rootReal, targetPath) {
    let current = path.resolve(targetPath);
    const root = path.resolve(rootReal);
    while (current !== root) {
        try {
            return await createAsyncDirectoryGuard(current);
        }
        catch (error) {
            if (!isNotFoundPathError(error)) {
                throw error;
            }
            current = path.dirname(current);
        }
    }
    return await createAsyncDirectoryGuard(root);
}
export function createNearestExistingSyncDirectoryGuard(rootReal, targetPath) {
    let current = path.resolve(targetPath);
    const root = path.resolve(rootReal);
    while (current !== root) {
        try {
            return createSyncDirectoryGuard(current);
        }
        catch (error) {
            if (!isNotFoundPathError(error)) {
                throw error;
            }
            current = path.dirname(current);
        }
    }
    return createSyncDirectoryGuard(root);
}
