import fs from "node:fs/promises";
import path from "node:path";
import { assertAsyncDirectoryGuard, createAsyncDirectoryGuard } from "./directory-guard.js";
import { FsSafeError } from "./errors.js";
import { isPathRelativeEscape } from "./path.js";
function isSameOrChildPath(candidate, parent) {
    const parentPrefix = parent.endsWith(path.sep) ? parent : `${parent}${path.sep}`;
    return candidate === parent || candidate.startsWith(parentPrefix);
}
export async function mkdirPathComponentsWithGuards(params) {
    const root = path.resolve(params.rootReal);
    const rootCanonical = path.resolve(await fs.realpath(root));
    const target = path.resolve(params.targetPath);
    const relative = path.relative(root, target);
    if (isPathRelativeEscape(relative)) {
        throw new FsSafeError("outside-workspace", "directory is outside workspace root");
    }
    let current = root;
    for (const part of relative.split(path.sep).filter(Boolean)) {
        const next = path.join(current, part);
        const parentGuard = await createAsyncDirectoryGuard(current);
        await params.beforeComponent?.(next);
        await assertAsyncDirectoryGuard(parentGuard);
        try {
            await fs.mkdir(next);
        }
        catch (error) {
            if (!error || typeof error !== "object" || !("code" in error) || error.code !== "EEXIST") {
                throw error;
            }
        }
        const stat = await fs.lstat(next);
        if (stat.isSymbolicLink() || !stat.isDirectory()) {
            throw new FsSafeError("not-file", "directory component must be a directory");
        }
        // Node's recursive mkdir follows symlinks in missing components. Build one
        // segment at a time and realpath-check each segment before descending.
        if (!isSameOrChildPath(path.resolve(await fs.realpath(next)), rootCanonical)) {
            throw new FsSafeError("outside-workspace", "directory escaped workspace root");
        }
        await createAsyncDirectoryGuard(next);
        await assertAsyncDirectoryGuard(parentGuard);
        current = next;
    }
}
