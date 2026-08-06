import { FsSafeError } from "./errors.js";
import { hasNodeErrorCode } from "./path.js";
export function isAlreadyExistsError(error) {
    return hasNodeErrorCode(error, "EEXIST") || /File exists|EEXIST/i.test(String(error));
}
export function normalizePinnedWriteError(error) {
    if (error instanceof FsSafeError) {
        return error;
    }
    return new FsSafeError("invalid-path", "path is not a regular file under root", {
        cause: error instanceof Error ? error : undefined,
    });
}
export function normalizePinnedPathError(error) {
    if (error instanceof FsSafeError) {
        return error;
    }
    return new FsSafeError("path-alias", "path is not under root", {
        cause: error instanceof Error ? error : undefined,
    });
}
