import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { FsSafeError } from "./errors.js";
import { expandHomePrefix } from "./home-dir.js";
import { assertNoNulPathInput, isNotFoundPathError, isPathInside } from "./path.js";
export const ensureTrailingSep = (value) => value.endsWith(path.sep) ? value : value + path.sep;
export function assertValidRootRelativePath(relativePath) {
    assertNoNulPathInput(relativePath, "relative path contains a NUL byte");
}
let cachedHomePath;
export async function expandRelativePathWithHome(relativePath) {
    const rawHome = process.env.HOME || process.env.USERPROFILE || os.homedir();
    if (cachedHomePath?.raw !== rawHome) {
        let realHome = rawHome;
        try {
            realHome = await fs.realpath(rawHome);
        }
        catch {
            // If the home dir cannot be canonicalized, keep lexical expansion behavior.
        }
        cachedHomePath = { raw: rawHome, real: realHome };
    }
    return expandHomePrefix(relativePath, { home: cachedHomePath.real });
}
export async function resolveRootContext(rootDir) {
    assertNoNulPathInput(rootDir, "root dir contains a NUL byte");
    let rootReal;
    try {
        rootReal = await fs.realpath(rootDir);
        const rootStat = await fs.stat(rootReal);
        if (!rootStat.isDirectory()) {
            throw new FsSafeError("invalid-path", "root dir is not a directory");
        }
    }
    catch (err) {
        if (err instanceof FsSafeError) {
            throw err;
        }
        if (isNotFoundPathError(err)) {
            throw new FsSafeError("not-found", "root dir not found");
        }
        throw err;
    }
    return {
        rootDir: path.resolve(rootDir),
        rootReal,
        rootWithSep: ensureTrailingSep(rootReal),
    };
}
export async function resolvePathInRoot(root, relativePath) {
    assertValidRootRelativePath(relativePath);
    const expanded = await expandRelativePathWithHome(relativePath);
    const resolved = path.resolve(root.rootWithSep, expanded);
    if (!isPathInside(root.rootWithSep, resolved)) {
        throw new FsSafeError("outside-workspace", "file is outside workspace root");
    }
    return { rootReal: root.rootReal, rootWithSep: root.rootWithSep, resolved };
}
export async function resolvePathWithinRoot(params) {
    return await resolvePathInRoot(await resolveRootContext(params.rootDir), params.relativePath);
}
