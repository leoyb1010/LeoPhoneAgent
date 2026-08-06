import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
function kindForDirent(dirent) {
    if (dirent.isDirectory())
        return "directory";
    if (dirent.isFile())
        return "file";
    if (dirent.isSymbolicLink())
        return "symlink";
    return "other";
}
function shouldStop(result, options) {
    return options.maxEntries !== undefined && result.scannedEntryCount >= Math.max(0, options.maxEntries);
}
function buildEntry(params) {
    const fullPath = path.join(params.dir, params.dirent.name);
    const relativePath = path.relative(params.rootDir, fullPath) || params.dirent.name;
    return {
        name: params.dirent.name,
        path: fullPath,
        relativePath,
        depth: params.depth,
        kind: params.kind ?? kindForDirent(params.dirent),
        dirent: params.dirent,
    };
}
function recordFailedDir(result, root, dir, depth, error) {
    const relativePath = path.relative(root, dir);
    result.failedDirs.push({
        path: dir,
        relativePath,
        depth: relativePath === "" ? 0 : depth - 1,
        error,
    });
}
function resolveSyncKind(fullPath, dirent, symlinks) {
    const kind = kindForDirent(dirent);
    if (kind !== "symlink")
        return kind;
    if (symlinks === "skip")
        return null;
    if (symlinks === "include")
        return "symlink";
    try {
        const stat = fsSync.statSync(fullPath);
        if (stat.isDirectory())
            return "directory";
        if (stat.isFile())
            return "file";
    }
    catch {
        return null;
    }
    return "other";
}
async function resolveAsyncKind(fullPath, dirent, symlinks) {
    const kind = kindForDirent(dirent);
    if (kind !== "symlink")
        return kind;
    if (symlinks === "skip")
        return null;
    if (symlinks === "include")
        return "symlink";
    try {
        const stat = await fs.stat(fullPath);
        if (stat.isDirectory())
            return "directory";
        if (stat.isFile())
            return "file";
    }
    catch {
        return null;
    }
    return "other";
}
export function walkDirectorySync(rootDir, options = {}) {
    const root = path.resolve(rootDir);
    const symlinks = options.symlinks ?? "skip";
    const result = {
        entries: [],
        scannedEntryCount: 0,
        truncated: false,
        failedDirs: [],
    };
    const visitedDirs = new Set();
    function visit(dir, depth) {
        if (options.maxDepth !== undefined && depth > options.maxDepth)
            return;
        let realDir;
        try {
            realDir = fsSync.realpathSync(dir);
        }
        catch (error) {
            recordFailedDir(result, root, dir, depth, error);
            return;
        }
        if (visitedDirs.has(realDir))
            return;
        visitedDirs.add(realDir);
        let entries;
        try {
            entries = fsSync.readdirSync(dir, { withFileTypes: true });
        }
        catch (error) {
            recordFailedDir(result, root, dir, depth, error);
            return;
        }
        for (const dirent of entries) {
            if (shouldStop(result, options)) {
                result.truncated = true;
                return;
            }
            result.scannedEntryCount += 1;
            const fullPath = path.join(dir, dirent.name);
            const kind = resolveSyncKind(fullPath, dirent, symlinks);
            if (!kind)
                continue;
            const entry = buildEntry({ rootDir: root, dir, dirent, depth, kind });
            if (options.include?.(entry) ?? true) {
                result.entries.push(entry);
            }
            if (kind === "directory" &&
                (options.maxDepth === undefined || depth < options.maxDepth) &&
                (options.descend?.(entry) ?? true)) {
                visit(fullPath, depth + 1);
                if (result.truncated)
                    return;
            }
        }
    }
    visit(root, 1);
    return result;
}
export async function walkDirectory(rootDir, options = {}) {
    const root = path.resolve(rootDir);
    const symlinks = options.symlinks ?? "skip";
    const result = {
        entries: [],
        scannedEntryCount: 0,
        truncated: false,
        failedDirs: [],
    };
    const visitedDirs = new Set();
    async function visit(dir, depth) {
        if (options.maxDepth !== undefined && depth > options.maxDepth)
            return;
        let realDir;
        try {
            realDir = await fs.realpath(dir);
        }
        catch (error) {
            recordFailedDir(result, root, dir, depth, error);
            return;
        }
        if (visitedDirs.has(realDir))
            return;
        visitedDirs.add(realDir);
        let entries;
        try {
            entries = await fs.readdir(dir, { withFileTypes: true });
        }
        catch (error) {
            recordFailedDir(result, root, dir, depth, error);
            return;
        }
        for (const dirent of entries) {
            if (shouldStop(result, options)) {
                result.truncated = true;
                return;
            }
            result.scannedEntryCount += 1;
            const fullPath = path.join(dir, dirent.name);
            const kind = await resolveAsyncKind(fullPath, dirent, symlinks);
            if (!kind)
                continue;
            const entry = buildEntry({ rootDir: root, dir, dirent, depth, kind });
            if (options.include?.(entry) ?? true) {
                result.entries.push(entry);
            }
            if (kind === "directory" &&
                (options.maxDepth === undefined || depth < options.maxDepth) &&
                (options.descend?.(entry) ?? true)) {
                await visit(fullPath, depth + 1);
                if (result.truncated)
                    return;
            }
        }
    }
    await visit(root, 1);
    return result;
}
