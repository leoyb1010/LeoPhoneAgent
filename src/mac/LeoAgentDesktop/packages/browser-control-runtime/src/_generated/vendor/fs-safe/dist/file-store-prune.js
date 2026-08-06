import fs from "node:fs/promises";
import path from "node:path";
import { FsSafeError } from "./errors.js";
import { isPathInside } from "./path.js";
import { root } from "./root.js";
import { getFsSafeTestHooks } from "./test-hooks.js";
export async function pruneExpiredStoreEntries(params) {
    const now = Date.now();
    const recursive = params.options.recursive ?? false;
    const maxDepth = params.options.maxDepth;
    const pruneEmptyDirs = (recursive || maxDepth !== undefined) && (params.options.pruneEmptyDirs ?? false);
    await fs.mkdir(params.rootDir, { recursive: true, mode: params.dirMode });
    const rootReal = await fs.realpath(params.rootDir);
    const scopedRoot = await root(rootReal);
    const rootGuard = {
        dir: rootReal,
        realPath: rootReal,
        stat: await fs.lstat(rootReal),
    };
    async function assertRootGuard() {
        const stat = await fs.lstat(rootGuard.dir);
        if (stat.isSymbolicLink() ||
            !stat.isDirectory() ||
            stat.dev !== rootGuard.stat.dev ||
            stat.ino !== rootGuard.stat.ino ||
            (await fs.realpath(rootGuard.dir)) !== rootGuard.realPath) {
            throw new FsSafeError("path-mismatch", "store root changed during prune");
        }
    }
    async function readStableDirectory(dir) {
        const before = await fs.lstat(dir).catch(() => null);
        if (!before || before.isSymbolicLink() || !before.isDirectory()) {
            return null;
        }
        const real = await fs.realpath(dir).catch(() => null);
        if (!real || !isPathInside(rootReal, real)) {
            return null;
        }
        const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => null);
        if (!entries) {
            return null;
        }
        const after = await fs.lstat(dir).catch(() => null);
        if (!after || before.dev !== after.dev || before.ino !== after.ino) {
            return null;
        }
        return entries;
    }
    async function pruneDir(dir, relativeDir, depth) {
        const entries = await readStableDirectory(dir);
        if (!entries) {
            return false;
        }
        for (const entry of entries) {
            const fullPath = path.join(dir, entry.name);
            const relativePath = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;
            const stat = await fs.lstat(fullPath).catch(() => null);
            if (!stat || stat.isSymbolicLink()) {
                continue;
            }
            if (stat.isDirectory()) {
                const shouldDescend = maxDepth !== undefined ? depth < maxDepth : recursive;
                if (shouldDescend) {
                    await getFsSafeTestHooks()?.beforeFileStorePruneDescend?.(fullPath);
                }
                if (shouldDescend && (await pruneDir(fullPath, relativePath, depth + 1))) {
                    await assertRootGuard();
                    // Keep empty-dir pruning on the same root-bounded remove path as files;
                    // the Root fallback handles empty directories without recursive delete.
                    await scopedRoot.remove(relativePath).catch(() => undefined);
                }
                continue;
            }
            if (stat.isFile() && now - stat.mtimeMs > params.options.ttlMs) {
                await assertRootGuard();
                await scopedRoot.remove(relativePath).catch(() => undefined);
            }
        }
        if (!pruneEmptyDirs) {
            return false;
        }
        const remaining = await readStableDirectory(dir);
        return remaining !== null && remaining.length === 0;
    }
    await pruneDir(rootReal, "", 0);
}
