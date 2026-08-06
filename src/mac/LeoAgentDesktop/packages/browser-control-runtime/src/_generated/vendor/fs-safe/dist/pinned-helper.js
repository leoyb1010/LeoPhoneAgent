import { isPinnedHelperUnavailable, runPinnedPythonOperation, validatePinnedOperationPayload, } from "./pinned-python.js";
export { isPinnedHelperUnavailable };
export async function runPinnedHelper(operation, rootDir, payload) {
    validatePinnedOperationPayload(payload);
    return await runPinnedPythonOperation({
        operation,
        rootPath: rootDir,
        payload,
    });
}
export async function helperStat(rootDir, relativePath) {
    return await runPinnedHelper("stat", rootDir, { relativePath });
}
export async function helperReaddir(rootDir, relativePath, withFileTypes) {
    return await runPinnedHelper("readdir", rootDir, {
        relativePath,
        withFileTypes,
    });
}
