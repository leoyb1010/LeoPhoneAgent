import { FsSafeError, type FsSafeErrorCode } from "./errors.js";
export type AbsolutePathSymlinkPolicy = "reject" | "follow";
export type ResolvedAbsolutePath = {
    path: string;
    canonicalPath: string;
};
export type ResolvedWritableAbsolutePath = ResolvedAbsolutePath & {
    parentDir: string;
    parentExists: boolean;
};
export type EnsureAbsoluteDirectoryOptions = {
    scopeLabel?: string;
    mode?: number;
};
export type EnsureAbsoluteDirectoryResult = {
    ok: true;
    path: string;
} | {
    ok: false;
    code: FsSafeErrorCode;
    error: FsSafeError;
};
export declare function assertAbsolutePathInput(filePath: string): string;
export declare function findExistingAncestor(filePath: string): Promise<string | null>;
export declare function ensureAbsoluteDirectory(dirPath: string, options?: EnsureAbsoluteDirectoryOptions): Promise<EnsureAbsoluteDirectoryResult>;
export declare function canonicalPathFromExistingAncestor(filePath: string): Promise<string>;
export declare function resolveAbsolutePathForRead(filePath: string, options?: {
    symlinks?: AbsolutePathSymlinkPolicy;
}): Promise<ResolvedAbsolutePath>;
export declare function resolveAbsolutePathForWrite(filePath: string, options?: {
    symlinks?: AbsolutePathSymlinkPolicy;
}): Promise<ResolvedWritableAbsolutePath>;
//# sourceMappingURL=absolute-path.d.ts.map