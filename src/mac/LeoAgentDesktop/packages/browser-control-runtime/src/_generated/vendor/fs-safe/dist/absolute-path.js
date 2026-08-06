import fs from "node:fs/promises";
import path from "node:path";
import { assertAsyncDirectoryGuard, createAsyncDirectoryGuard, } from "./directory-guard.js";
import { FsSafeError } from "./errors.js";
function ensureDirectoryFailure(code, message, cause) {
    return {
        ok: false,
        code,
        error: new FsSafeError(code, message, { cause }),
    };
}
async function assertGuardResult(guard, scopeLabel) {
    try {
        await assertAsyncDirectoryGuard(guard);
        return { ok: true };
    }
    catch (err) {
        if (err instanceof FsSafeError) {
            return await directoryGuardFailure(err, guard.dir, scopeLabel);
        }
        throw err;
    }
}
async function createDirectoryGuardResult(dir, scopeLabel) {
    try {
        return { ok: true, guard: await createAsyncDirectoryGuard(dir) };
    }
    catch (err) {
        if (err instanceof FsSafeError) {
            return await directoryGuardFailure(err, dir, scopeLabel);
        }
        throw err;
    }
}
function classifyDirectoryLookupError(err, scopeLabel) {
    const code = err.code;
    if (code === "ENOENT") {
        return ensureDirectoryFailure("not-found", `directory path must have a real existing ancestor within ${scopeLabel}`, err);
    }
    if (code === "ENOTDIR") {
        return ensureDirectoryFailure("not-file", `path must be a real directory within ${scopeLabel}`, err);
    }
    return null;
}
function classifyExistingDirectorySegment(stat, scopeLabel) {
    if (stat.isSymbolicLink()) {
        return ensureDirectoryFailure("symlink", `directory path traverses a symlink within ${scopeLabel}`);
    }
    if (!stat.isDirectory()) {
        return ensureDirectoryFailure("not-file", `path must be a real directory within ${scopeLabel}`);
    }
    return null;
}
async function directoryGuardFailure(err, dir, scopeLabel) {
    if (err.code !== "not-file") {
        return { ok: false, code: err.code, error: err };
    }
    try {
        const stat = await fs.lstat(dir);
        const failure = classifyExistingDirectorySegment(stat, scopeLabel);
        if (failure) {
            return failure;
        }
    }
    catch (lookupErr) {
        const failure = classifyDirectoryLookupError(lookupErr, scopeLabel);
        if (failure) {
            return failure;
        }
        throw lookupErr;
    }
    return { ok: false, code: err.code, error: err };
}
async function resolveTrustedDirectoryPrefix(targetPath, scopeLabel) {
    const root = path.parse(targetPath).root;
    let current = root;
    let currentStat;
    try {
        currentStat = await fs.lstat(current);
    }
    catch (err) {
        const failure = classifyDirectoryLookupError(err, scopeLabel);
        if (failure) {
            return failure;
        }
        throw err;
    }
    const rootFailure = classifyExistingDirectorySegment(currentStat, scopeLabel);
    if (rootFailure) {
        return rootFailure;
    }
    // Walk forward with lstat. Looking backward for the "nearest existing
    // ancestor" can cross an existing suffix through a symlinked parent before
    // this helper gets a chance to reject that parent.
    const segments = path.relative(root, targetPath).split(path.sep).filter(Boolean);
    for (let index = 0; index < segments.length; index += 1) {
        const segment = segments[index];
        if (!segment) {
            continue;
        }
        const next = path.join(current, segment);
        try {
            const nextStat = await fs.lstat(next);
            const segmentFailure = classifyExistingDirectorySegment(nextStat, scopeLabel);
            if (segmentFailure) {
                return segmentFailure;
            }
            current = next;
            currentStat = nextStat;
        }
        catch (err) {
            const code = err.code;
            if (code === "ENOENT") {
                return {
                    ok: true,
                    ancestorPath: current,
                    missingSegments: segments.slice(index),
                };
            }
            const failure = classifyDirectoryLookupError(err, scopeLabel);
            if (failure) {
                return failure;
            }
            throw err;
        }
    }
    return { ok: true, ancestorPath: current, missingSegments: [] };
}
export function assertAbsolutePathInput(filePath) {
    if (!filePath) {
        throw new FsSafeError("invalid-path", "path is required");
    }
    if (filePath.includes("\0")) {
        throw new FsSafeError("invalid-path", "path must not contain NUL bytes");
    }
    if (!path.isAbsolute(filePath)) {
        throw new FsSafeError("invalid-path", "path must be absolute");
    }
    return path.normalize(filePath);
}
async function pathExists(filePath) {
    try {
        await fs.access(filePath);
        return true;
    }
    catch {
        return false;
    }
}
export async function findExistingAncestor(filePath) {
    return (await findExistingAncestorWithStat(filePath))?.path ?? null;
}
async function findExistingAncestorWithStat(filePath) {
    let current = path.resolve(filePath);
    while (true) {
        try {
            return { path: current, stat: await fs.lstat(current) };
        }
        catch (err) {
            if (err.code !== "ENOENT") {
                throw err;
            }
        }
        const parent = path.dirname(current);
        if (parent === current) {
            return null;
        }
        current = parent;
    }
}
export async function ensureAbsoluteDirectory(dirPath, options = {}) {
    const scopeLabel = options.scopeLabel ?? "directory";
    let targetPath;
    try {
        targetPath = assertAbsolutePathInput(dirPath);
    }
    catch (err) {
        if (err instanceof FsSafeError) {
            return { ok: false, code: err.code, error: err };
        }
        throw err;
    }
    const prefix = await resolveTrustedDirectoryPrefix(targetPath, scopeLabel);
    if (!prefix.ok) {
        return prefix;
    }
    let current = prefix.ancestorPath;
    const initialGuard = await createDirectoryGuardResult(prefix.ancestorPath, scopeLabel);
    if (!initialGuard.ok) {
        return initialGuard;
    }
    let currentGuard = initialGuard.guard;
    for (const segment of prefix.missingSegments) {
        current = path.join(current, segment);
        while (true) {
            const guardResult = await assertGuardResult(currentGuard, scopeLabel);
            if (!guardResult.ok) {
                return guardResult;
            }
            try {
                const stat = await fs.lstat(current);
                if (stat.isSymbolicLink()) {
                    return ensureDirectoryFailure("symlink", `directory path traverses a symlink within ${scopeLabel}`);
                }
                if (!stat.isDirectory()) {
                    return ensureDirectoryFailure("not-file", `path must be a real directory within ${scopeLabel}`);
                }
                break;
            }
            catch (err) {
                if (err.code !== "ENOENT") {
                    throw err;
                }
                const parentStillValid = await assertGuardResult(currentGuard, scopeLabel);
                if (!parentStillValid.ok) {
                    return parentStillValid;
                }
                try {
                    await fs.mkdir(current, { mode: options.mode });
                }
                catch (mkdirErr) {
                    if (mkdirErr.code === "EEXIST") {
                        continue;
                    }
                    throw mkdirErr;
                }
            }
        }
        const nextGuard = await createDirectoryGuardResult(current, scopeLabel);
        if (!nextGuard.ok) {
            return nextGuard;
        }
        const previousGuardStillValid = await assertGuardResult(currentGuard, scopeLabel);
        if (!previousGuardStillValid.ok) {
            return previousGuardStillValid;
        }
        currentGuard = nextGuard.guard;
    }
    const finalGuardResult = await assertGuardResult(currentGuard, scopeLabel);
    if (!finalGuardResult.ok) {
        return finalGuardResult;
    }
    return { ok: true, path: targetPath };
}
export async function canonicalPathFromExistingAncestor(filePath) {
    const ancestor = await findExistingAncestor(filePath);
    if (!ancestor) {
        return path.resolve(filePath);
    }
    let canonicalAncestor = ancestor;
    try {
        canonicalAncestor = await fs.realpath(ancestor);
    }
    catch {
        // Keep lexical path when the existing ancestor cannot be canonicalized.
    }
    const relative = path.relative(ancestor, filePath);
    return relative ? path.join(canonicalAncestor, relative) : canonicalAncestor;
}
export async function resolveAbsolutePathForRead(filePath, options = {}) {
    const normalized = assertAbsolutePathInput(filePath);
    let canonicalPath;
    try {
        canonicalPath = await fs.realpath(normalized);
    }
    catch (err) {
        if (err.code === "ENOENT") {
            throw new FsSafeError("not-found", "path not found", { cause: err });
        }
        throw err;
    }
    if ((options.symlinks ?? "reject") === "reject" && canonicalPath !== normalized) {
        throw new FsSafeError("symlink", "path traverses a symlink", { cause: { canonicalPath } });
    }
    return { path: normalized, canonicalPath };
}
export async function resolveAbsolutePathForWrite(filePath, options = {}) {
    const normalized = assertAbsolutePathInput(filePath);
    const parentDir = path.dirname(normalized);
    const parentExists = await pathExists(parentDir);
    if ((options.symlinks ?? "reject") === "reject") {
        const ancestor = await findExistingAncestor(parentDir);
        if (ancestor) {
            const canonicalAncestor = await fs.realpath(ancestor).catch(() => ancestor);
            if (canonicalAncestor !== ancestor) {
                const canonicalPath = path.join(canonicalAncestor, path.relative(ancestor, normalized));
                throw new FsSafeError("symlink", "path traverses a symlink", {
                    cause: { canonicalPath },
                });
            }
        }
    }
    return {
        path: normalized,
        canonicalPath: await canonicalPathFromExistingAncestor(normalized),
        parentDir,
        parentExists,
    };
}
