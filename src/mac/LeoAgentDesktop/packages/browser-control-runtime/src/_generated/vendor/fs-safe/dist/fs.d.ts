/**
 * Returns true when `fs.stat()` can stat the path.
 *
 * This follows stat semantics: broken symlinks return false, while symlinks to
 * existing targets return true.
 */
export declare function pathExists(filePath: string): Promise<boolean>;
/**
 * Synchronous counterpart to `pathExists()`, with the same `fs.statSync()`
 * semantics.
 */
export declare function pathExistsSync(filePath: string): boolean;
//# sourceMappingURL=fs.d.ts.map