import fs from "node:fs/promises";
import path from "node:path";
import { normalizeLowercaseStringOrEmpty } from "./string-coerce.js";
const TAR_SUFFIXES = [".tgz", ".tar.gz", ".tar"];
export function resolveArchiveKind(filePath) {
    const lower = normalizeLowercaseStringOrEmpty(filePath);
    if (lower.endsWith(".zip")) {
        return "zip";
    }
    if (TAR_SUFFIXES.some((suffix) => lower.endsWith(suffix))) {
        return "tar";
    }
    return null;
}
async function hasPackedRootMarker(extractDir, rootMarkers) {
    for (const marker of rootMarkers) {
        const trimmed = marker.trim();
        if (!trimmed) {
            continue;
        }
        try {
            await fs.stat(path.join(extractDir, trimmed));
            return true;
        }
        catch {
            // ignore
        }
    }
    return false;
}
export async function resolvePackedRootDir(extractDir, options) {
    const direct = path.join(extractDir, "package");
    try {
        const stat = await fs.stat(direct);
        if (stat.isDirectory()) {
            return direct;
        }
    }
    catch {
        // ignore
    }
    if ((options?.rootMarkers?.length ?? 0) > 0) {
        const hasMarker = await hasPackedRootMarker(extractDir, options?.rootMarkers ?? []);
        if (hasMarker) {
            return extractDir;
        }
    }
    const entries = await fs.readdir(extractDir, { withFileTypes: true });
    const dirs = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
    if (dirs.length !== 1) {
        throw new Error(`unexpected archive layout (dirs: ${dirs.join(", ")})`);
    }
    const onlyDir = dirs[0];
    if (!onlyDir) {
        throw new Error("unexpected archive layout (no package dir found)");
    }
    return path.join(extractDir, onlyDir);
}
