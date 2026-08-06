import { FsSafeError } from "./errors.js";
import { canFallbackFromPythonError } from "./pinned-python-config.js";
import { runPinnedHelper } from "./pinned-helper.js";
export function isPinnedPathHelperSpawnError(error) {
    return canFallbackFromPythonError(error);
}
export async function runPinnedPathHelper(params) {
    try {
        await runPinnedHelper(params.operation, params.rootPath, {
            relativePath: params.relativePath,
        });
    }
    catch (error) {
        if (error instanceof FsSafeError) {
            throw error;
        }
        throw new FsSafeError("helper-failed", "pinned path helper failed", {
            cause: error instanceof Error ? error : undefined,
        });
    }
}
