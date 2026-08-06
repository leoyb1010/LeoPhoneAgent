import fs from "node:fs";
import fsp from "node:fs/promises";
/**
 * Returns true when `fs.stat()` can stat the path.
 *
 * This follows stat semantics: broken symlinks return false, while symlinks to
 * existing targets return true.
 */
export async function pathExists(filePath) {
    try {
        await fsp.stat(filePath);
        return true;
    }
    catch {
        return false;
    }
}
/**
 * Synchronous counterpart to `pathExists()`, with the same `fs.statSync()`
 * semantics.
 */
export function pathExistsSync(filePath) {
    try {
        fs.statSync(filePath);
        return true;
    }
    catch {
        return false;
    }
}
