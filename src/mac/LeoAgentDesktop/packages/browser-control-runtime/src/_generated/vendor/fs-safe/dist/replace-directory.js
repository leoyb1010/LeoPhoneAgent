import fs from "node:fs/promises";
import path from "node:path";
import { guardedRename, guardedRm } from "./guarded-mutation.js";
export async function replaceDirectoryAtomic(options) {
    const targetDir = path.resolve(options.targetDir);
    const stagedDir = path.resolve(options.stagedDir);
    const parentDir = path.dirname(targetDir);
    const backupDir = path.join(parentDir, `${options.backupPrefix ?? ".fs-safe-dir-backup-"}${process.pid}-${Date.now()}`);
    let backupCreated = false;
    await fs.mkdir(parentDir, { recursive: true });
    try {
        await guardedRename({ from: targetDir, to: backupDir });
        backupCreated = true;
    }
    catch (err) {
        if (err.code !== "ENOENT") {
            throw err;
        }
    }
    try {
        await guardedRename({ from: stagedDir, to: targetDir });
    }
    catch (err) {
        if (backupCreated) {
            await guardedRename({ from: backupDir, to: targetDir }).catch(() => undefined);
            backupCreated = false;
        }
        throw err;
    }
    if (backupCreated) {
        await guardedRm({ target: backupDir, recursive: true, force: true, verifyAfter: false });
    }
}
