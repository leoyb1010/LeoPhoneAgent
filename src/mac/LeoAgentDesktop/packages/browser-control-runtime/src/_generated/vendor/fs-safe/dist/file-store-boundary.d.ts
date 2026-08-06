import { type Readable } from "node:stream";
import { type SyncDirectoryGuard } from "./directory-guard.js";
import { type Root } from "./root.js";
export type SyncParentGuard = SyncDirectoryGuard;
export declare function ensureParentInRoot(scopedRoot: Root, relativePath: string, mode: number): Promise<void>;
export declare function openWritableStoreRoot(params: {
    rootDir: string;
    dirMode: number;
    maxBytes?: number;
}): Promise<Root>;
export declare function writeStreamToTempSource(params: {
    stream: Readable;
    maxBytes?: number;
    mode: number;
}): Promise<{
    path: string;
    cleanup: () => Promise<void>;
}>;
export declare function assertSyncDirectoryGuard(guard: SyncParentGuard): void;
export declare function ensureParentSync(params: {
    rootDir: string;
    filePath: string;
    mode: number;
}): SyncParentGuard;
//# sourceMappingURL=file-store-boundary.d.ts.map