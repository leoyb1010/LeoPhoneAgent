import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { isPathInside } from "./path.js";
export function safeDirName(input) {
    const trimmed = input.trim();
    if (!trimmed) {
        return trimmed;
    }
    return trimmed.replaceAll("/", "__").replaceAll("\\", "__");
}
export function safePathSegmentHashed(input) {
    const trimmed = input.trim();
    const base = trimmed
        .replaceAll(/[\\/]/g, "-")
        .replaceAll(/[^a-zA-Z0-9._-]/g, "-")
        .replaceAll(/-+/g, "-")
        .replaceAll(/^-+/g, "")
        .replaceAll(/-+$/g, "");
    const normalized = base.length > 0 ? base : "skill";
    const safe = normalized === "." || normalized === ".." ? "skill" : normalized;
    const hash = createHash("sha256").update(trimmed).digest("hex").slice(0, 10);
    if (safe !== trimmed) {
        const prefix = safe.length > 50 ? safe.slice(0, 50) : safe;
        return `${prefix}-${hash}`;
    }
    if (safe.length > 60) {
        return `${safe.slice(0, 50)}-${hash}`;
    }
    return safe;
}
export function resolveSafeInstallDir(params) {
    const encodedName = (params.nameEncoder ?? safeDirName)(params.id);
    const targetDir = path.join(params.baseDir, encodedName);
    const resolvedBase = path.resolve(params.baseDir);
    const resolvedTarget = path.resolve(targetDir);
    const relative = path.relative(resolvedBase, resolvedTarget);
    if (!relative ||
        relative === ".." ||
        relative.startsWith(`..${path.sep}`) ||
        path.isAbsolute(relative)) {
        return { ok: false, error: params.invalidNameMessage };
    }
    return { ok: true, path: targetDir };
}
export async function assertCanonicalPathWithinBase(params) {
    const baseDir = path.resolve(params.baseDir);
    const candidatePath = path.resolve(params.candidatePath);
    if (!isPathInside(baseDir, candidatePath)) {
        throw new Error(`Invalid path: must stay within ${params.boundaryLabel}`);
    }
    const baseLstat = await fs.lstat(baseDir);
    if (baseLstat.isSymbolicLink()) {
        const baseStat = await fs.stat(baseDir);
        if (!baseStat.isDirectory()) {
            throw new Error(`Invalid ${params.boundaryLabel}: base directory must resolve to a directory`);
        }
    }
    else if (!baseLstat.isDirectory()) {
        throw new Error(`Invalid ${params.boundaryLabel}: base directory must be a directory`);
    }
    const baseRealPath = await fs.realpath(baseDir);
    const validateDirectory = async (dirPath) => {
        const resolvedDirPath = path.resolve(dirPath);
        const dirLstat = await fs.lstat(dirPath);
        if (dirLstat.isSymbolicLink()) {
            if (resolvedDirPath !== baseDir) {
                throw new Error(`Invalid path: must stay within ${params.boundaryLabel}`);
            }
            const dirStat = await fs.stat(dirPath);
            if (!dirStat.isDirectory()) {
                throw new Error(`Invalid path: must stay within ${params.boundaryLabel}`);
            }
        }
        else if (!dirLstat.isDirectory()) {
            throw new Error(`Invalid path: must stay within ${params.boundaryLabel}`);
        }
        const dirRealPath = await fs.realpath(dirPath);
        if (!isPathInside(baseRealPath, dirRealPath)) {
            throw new Error(`Invalid path: must stay within ${params.boundaryLabel}`);
        }
    };
    try {
        await validateDirectory(candidatePath);
        return;
    }
    catch (err) {
        const code = err.code;
        if (code !== "ENOENT") {
            throw err;
        }
    }
    await validateDirectory(path.dirname(candidatePath));
}
