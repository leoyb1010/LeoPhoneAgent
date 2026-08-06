import fs from "node:fs/promises";
import path from "node:path";
import { FsSafeError } from "./errors.js";
import { sameFileIdentity } from "./file-identity.js";
import { isNotFoundPathError } from "./path.js";
export async function resolveOpenedFileRealPathForHandle(handle, ioPath) {
    const handleStat = await handle.stat();
    const fdCandidates = process.platform === "linux"
        ? [`/proc/self/fd/${handle.fd}`, `/dev/fd/${handle.fd}`]
        : process.platform === "win32"
            ? []
            : [`/dev/fd/${handle.fd}`];
    for (const fdPath of fdCandidates) {
        try {
            const fdRealPath = await fs.realpath(fdPath);
            const fdRealStat = await fs.stat(fdRealPath);
            if (sameFileIdentity(handleStat, fdRealStat)) {
                return fdRealPath;
            }
        }
        catch {
            // try next fd path
        }
    }
    try {
        const ioRealPath = await fs.realpath(ioPath);
        const ioRealStat = await fs.stat(ioRealPath);
        if (sameFileIdentity(handleStat, ioRealStat)) {
            return ioRealPath;
        }
    }
    catch (err) {
        if (!isNotFoundPathError(err)) {
            throw err;
        }
    }
    const parentResolved = await resolveOpenedFileRealPathFromParent(handleStat, ioPath);
    if (parentResolved) {
        return parentResolved;
    }
    throw new FsSafeError("path-mismatch", "unable to resolve opened file path");
}
async function resolveOpenedFileRealPathFromParent(handleStat, ioPath) {
    let parentReal;
    try {
        parentReal = await fs.realpath(path.dirname(ioPath));
    }
    catch (err) {
        if (isNotFoundPathError(err)) {
            return null;
        }
        throw err;
    }
    let entries;
    try {
        entries = await fs.readdir(parentReal);
    }
    catch (err) {
        if (isNotFoundPathError(err)) {
            return null;
        }
        throw err;
    }
    for (const entry of entries.toSorted()) {
        const candidatePath = path.join(parentReal, entry);
        try {
            const candidateStat = await fs.lstat(candidatePath);
            if (candidateStat.isFile() && sameFileIdentity(handleStat, candidateStat)) {
                return await fs.realpath(candidatePath);
            }
        }
        catch (err) {
            if (!isNotFoundPathError(err)) {
                throw err;
            }
        }
    }
    return null;
}
