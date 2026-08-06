import fsSync from "node:fs";
import fs from "node:fs/promises";
export async function syncDirectoryBestEffort(dirPath) {
    if (process.platform === "win32") {
        return;
    }
    let handle;
    try {
        const flags = fsSync.constants.O_RDONLY |
            ("O_DIRECTORY" in fsSync.constants ? fsSync.constants.O_DIRECTORY : 0) |
            ("O_NOFOLLOW" in fsSync.constants ? fsSync.constants.O_NOFOLLOW : 0);
        handle = await fs.open(dirPath, flags);
        await handle.sync();
    }
    catch {
        // Some filesystems reject directory handles; keep the write usable there.
    }
    finally {
        await handle?.close().catch(() => undefined);
    }
}
