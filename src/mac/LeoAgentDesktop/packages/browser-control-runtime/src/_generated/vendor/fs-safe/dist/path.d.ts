import fs from "node:fs";
export { assertNoUnsafeDeviceReadPath, isUnsafeDeviceReadPath, matchUnsafeDeviceReadPath, type UnsafeDeviceReadPathMatch, type UnsafeDeviceReadPathOptions, type UnsafeDeviceReadPathReason, } from "./device-path.js";
export declare function normalizeWindowsPathForComparison(input: string): string;
export declare function isNodeError(value: unknown): value is NodeJS.ErrnoException;
export declare function hasNodeErrorCode(value: unknown, code: string): boolean;
export declare function assertNoNulPathInput(filePath: string, message?: string): void;
export declare function isNotFoundPathError(value: unknown): boolean;
export declare function isSymlinkOpenError(value: unknown): boolean;
export declare function isPathInside(root: string, target: string): boolean;
export declare function isPathRelativeEscape(relativePath: string): boolean;
export declare function resolveSafeBaseDir(rootDir: string): string;
export declare function isWithinDir(rootDir: string, targetPath: string): boolean;
export declare function safeRealpathSync(targetPath: string, cache?: Map<string, string>): string | null;
export declare function isPathInsideWithRealpath(basePath: string, candidatePath: string, opts?: {
    requireRealpath?: boolean;
    cache?: Map<string, string>;
}): boolean;
export declare function safeStatSync(targetPath: string): fs.Stats | null;
export declare function splitSafeRelativePath(relativePath: string): string[];
export declare function resolveSafeRelativePath(rootDir: string, relativePath: string): string;
//# sourceMappingURL=path.d.ts.map