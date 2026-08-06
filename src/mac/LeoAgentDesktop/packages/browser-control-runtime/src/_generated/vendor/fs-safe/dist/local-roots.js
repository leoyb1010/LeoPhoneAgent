import fsSync from "node:fs";
import path from "node:path";
import { FsSafeError } from "./errors.js";
import { expandHomePrefix, resolveUserPath } from "./home-dir.js";
import { safeFileURLToPath } from "./local-file-access.js";
import { isPathInside } from "./path.js";
import { root } from "./root.js";
function resolveLocalPathInput(input, label) {
    if (input.startsWith("file://")) {
        try {
            return safeFileURLToPath(input);
        }
        catch {
            const location = label === "file path" ? "" : ` in ${label}`;
            throw new Error(`Invalid file:// URL${location}: ${input}`);
        }
    }
    if (input.includes("\0")) {
        throw new FsSafeError("invalid-path", `${label} must not contain NUL bytes`);
    }
    return resolveUserPath(input);
}
function resolveLocalRootInput(input, label) {
    const trimmed = input.trim();
    if (!trimmed) {
        throw new FsSafeError("invalid-path", `${label} entry is required`);
    }
    const resolved = trimmed.startsWith("file://")
        ? resolveLocalPathInput(trimmed, label)
        : expandHomePrefix(trimmed);
    if (resolved.includes("\0")) {
        throw new FsSafeError("invalid-path", `${label} entry must not contain NUL bytes`);
    }
    if (!path.isAbsolute(resolved)) {
        throw new FsSafeError("invalid-path", `${label} entries must be absolute paths: ${input}`);
    }
    return path.resolve(resolved);
}
function isPathInsideRoot(candidate, rootDir) {
    return isPathInside(rootDir, candidate);
}
function resolveRootRealSync(rootDir) {
    try {
        const stat = fsSync.lstatSync(rootDir);
        if (!stat.isDirectory()) {
            return null;
        }
        return fsSync.realpathSync(rootDir);
    }
    catch {
        return null;
    }
}
function resolveCandidateCanonicalSync(filePath) {
    let sawExistingLeaf = false;
    try {
        const stat = fsSync.lstatSync(filePath);
        sawExistingLeaf = true;
        return {
            exists: true,
            canonicalPath: fsSync.realpathSync(filePath),
            isFile: stat.isFile(),
        };
    }
    catch (err) {
        if (err.code !== "ENOENT") {
            throw err;
        }
    }
    if (sawExistingLeaf) {
        // lstat succeeded but realpath failed: this is an existing dangling
        // symlink, not a missing path callers may safely create through.
        throw new FsSafeError("symlink", "local roots candidate is a dangling symlink");
    }
    let cursor = filePath;
    const missingSegments = [];
    while (true) {
        const parent = path.dirname(cursor);
        if (parent === cursor) {
            return { exists: false, canonicalPath: filePath };
        }
        missingSegments.unshift(path.basename(cursor));
        cursor = parent;
        try {
            fsSync.lstatSync(cursor);
            const ancestorReal = fsSync.realpathSync(cursor);
            return {
                exists: false,
                canonicalPath: path.join(ancestorReal, ...missingSegments),
            };
        }
        catch (err) {
            if (err.code !== "ENOENT") {
                // Existing ancestors that cannot be canonicalized are symlink/error
                // terrain; do not reconstruct a trusted missing path through them.
                throw err;
            }
        }
    }
}
export function resolveLocalPathFromRootsSync(options) {
    const label = options.label ?? "local roots";
    const requestedPath = path.resolve(resolveLocalPathInput(options.filePath, "file path"));
    for (const rootEntry of options.roots) {
        const rootDir = resolveLocalRootInput(rootEntry, label);
        const rootReal = resolveRootRealSync(rootDir);
        if (!rootReal) {
            continue;
        }
        let candidate;
        try {
            candidate = resolveCandidateCanonicalSync(requestedPath);
        }
        catch {
            continue;
        }
        if (!candidate.exists && options.allowMissing !== true) {
            continue;
        }
        if (candidate.exists && options.requireFile === true && !candidate.isFile) {
            continue;
        }
        if (isPathInsideRoot(candidate.canonicalPath, rootReal)) {
            return { path: candidate.canonicalPath, root: rootReal };
        }
    }
    return null;
}
export async function readLocalFileFromRoots(options) {
    const label = options.label ?? "local roots";
    const requestedPath = path.resolve(resolveLocalPathInput(options.filePath, "file path"));
    for (const rootEntry of options.roots) {
        const rootDir = resolveLocalRootInput(rootEntry, label);
        let scopedRoot;
        try {
            scopedRoot = await root(rootDir);
        }
        catch {
            continue;
        }
        const relativePath = path.relative(scopedRoot.rootDir, requestedPath);
        if (!relativePath ||
            relativePath === ".." ||
            relativePath.startsWith(`..${path.sep}`) ||
            path.isAbsolute(relativePath)) {
            continue;
        }
        try {
            const readOptions = {
                hardlinks: options.hardlinks,
                nonBlockingRead: options.nonBlockingRead,
                symlinks: options.symlinks,
            };
            // Leave maxBytes absent when the caller omits it so Root's own default
            // cap remains in force instead of being overwritten by undefined.
            if (options.maxBytes !== undefined) {
                readOptions.maxBytes = options.maxBytes;
            }
            const result = await scopedRoot.read(relativePath, readOptions);
            return { ...result, root: scopedRoot.rootReal };
        }
        catch {
            continue;
        }
    }
    return null;
}
