import fsSync from "node:fs";
export type WalkEntryKind = "file" | "directory" | "symlink" | "other";
export type WalkSymlinkPolicy = "skip" | "follow" | "include";
export type WalkDirectoryEntry = {
    name: string;
    path: string;
    relativePath: string;
    depth: number;
    kind: WalkEntryKind;
    dirent: fsSync.Dirent;
};
export type WalkDirectoryOptions = {
    maxDepth?: number;
    maxEntries?: number;
    symlinks?: WalkSymlinkPolicy;
    include?: (entry: WalkDirectoryEntry) => boolean;
    descend?: (entry: WalkDirectoryEntry) => boolean;
};
export type WalkDirectoryFailure = {
    path: string;
    relativePath: string;
    depth: number;
    error: unknown;
};
export type WalkDirectoryResult = {
    entries: WalkDirectoryEntry[];
    scannedEntryCount: number;
    truncated: boolean;
    failedDirs?: WalkDirectoryFailure[];
};
type WalkDirectoryResultWithFailures = WalkDirectoryResult & {
    failedDirs: WalkDirectoryFailure[];
};
export declare function walkDirectorySync(rootDir: string, options?: WalkDirectoryOptions): WalkDirectoryResultWithFailures;
export declare function walkDirectory(rootDir: string, options?: WalkDirectoryOptions): Promise<WalkDirectoryResultWithFailures>;
export {};
//# sourceMappingURL=walk.d.ts.map