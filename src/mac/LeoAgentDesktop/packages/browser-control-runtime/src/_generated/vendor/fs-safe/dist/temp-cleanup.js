import fsSync from "node:fs";
const tempCleanupEntries = new Map();
let cleanupRegistered = false;
function cleanupRegisteredTempPathsSync() {
    for (const entry of tempCleanupEntries.values()) {
        try {
            fsSync.rmSync(entry.path, { force: true, recursive: entry.recursive });
        }
        catch {
            // Process-exit cleanup is best-effort.
        }
    }
    tempCleanupEntries.clear();
}
export function registerTempPathForExit(tempPath, options) {
    if (!cleanupRegistered) {
        cleanupRegistered = true;
        process.once("exit", cleanupRegisteredTempPathsSync);
    }
    tempCleanupEntries.set(tempPath, {
        path: tempPath,
        recursive: options?.recursive === true,
    });
    return () => {
        tempCleanupEntries.delete(tempPath);
    };
}
export function __cleanupRegisteredTempPathsForTest() {
    cleanupRegisteredTempPathsSync();
}
export function __cleanupRegisteredTempPathForTest(tempPath) {
    const entry = tempCleanupEntries.get(tempPath);
    if (!entry) {
        return;
    }
    try {
        fsSync.rmSync(entry.path, { force: true, recursive: entry.recursive });
    }
    finally {
        tempCleanupEntries.delete(tempPath);
    }
}
