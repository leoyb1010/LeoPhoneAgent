import syncFs from "node:fs";
import fs from "node:fs/promises";
export type ReplaceFileAtomicFileSystem = {
    promises: Pick<typeof fs, "mkdir" | "chmod" | "writeFile" | "rename" | "copyFile" | "unlink" | "rm" | "open" | "stat" | "lstat">;
};
export type ReplaceFileAtomicSyncFileSystem = Pick<typeof syncFs, "mkdirSync" | "chmodSync" | "readFileSync" | "writeFileSync" | "renameSync" | "copyFileSync" | "unlinkSync" | "rmSync" | "openSync" | "fsyncSync" | "closeSync" | "statSync" | "lstatSync">;
type ReplaceFileAtomicBaseOptions = {
    filePath: string;
    content: string | Uint8Array;
    dirMode?: number;
    mode?: number;
    preserveExistingMode?: boolean;
    tempPrefix?: string;
    renameMaxRetries?: number;
    renameRetryBaseDelayMs?: number;
    copyFallbackOnPermissionError?: boolean;
    syncTempFile?: boolean;
    syncParentDir?: boolean;
    throwOnCleanupError?: boolean;
};
export type ReplaceFileAtomicOptions = ReplaceFileAtomicBaseOptions & {
    fileSystem?: ReplaceFileAtomicFileSystem;
    beforeRename?: (params: {
        filePath: string;
        tempPath: string;
    }) => Promise<void>;
};
export type ReplaceFileAtomicSyncOptions = ReplaceFileAtomicBaseOptions & {
    fileSystem?: ReplaceFileAtomicSyncFileSystem;
    beforeRename?: (params: {
        filePath: string;
        tempPath: string;
    }) => void;
};
export type ReplaceFileAtomicResult = {
    method: "rename" | "copy-fallback";
};
export declare function replaceFileAtomic(options: ReplaceFileAtomicOptions): Promise<ReplaceFileAtomicResult>;
export declare function replaceFileAtomicSync(options: ReplaceFileAtomicSyncOptions): ReplaceFileAtomicResult;
export {};
//# sourceMappingURL=replace-file.d.ts.map