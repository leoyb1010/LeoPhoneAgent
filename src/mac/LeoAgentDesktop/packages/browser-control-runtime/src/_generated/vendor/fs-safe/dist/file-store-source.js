import fs from "node:fs/promises";
import { FsSafeError } from "./errors.js";
import { readRegularFile } from "./regular-file.js";
export async function readFileStoreCopySource(params) {
    const sourceStat = await fs.lstat(params.sourcePath);
    if (sourceStat.isSymbolicLink() || !sourceStat.isFile()) {
        throw new FsSafeError("not-file", "source path is not a file");
    }
    if (params.maxBytes !== undefined && sourceStat.size > params.maxBytes) {
        throw new FsSafeError("too-large", `file exceeds maximum size of ${params.maxBytes} bytes`);
    }
    try {
        return (await readRegularFile({ filePath: params.sourcePath, maxBytes: params.maxBytes }))
            .buffer;
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (message.includes("regular file") || message.includes("not a regular file")) {
            throw new FsSafeError("not-file", "source path is not a file", {
                cause: error instanceof Error ? error : undefined,
            });
        }
        if (params.maxBytes !== undefined && message.includes(`exceeds ${params.maxBytes} bytes`)) {
            throw new FsSafeError("too-large", `file exceeds maximum size of ${params.maxBytes} bytes`, {
                cause: error instanceof Error ? error : undefined,
            });
        }
        throw error;
    }
}
