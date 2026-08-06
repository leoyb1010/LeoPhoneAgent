export type WriteSiblingTempFileOptions<T> = {
    dir: string;
    writeTemp: (tempPath: string) => Promise<T>;
    resolveFinalPath: (result: T) => string;
    tempPrefix?: string;
    dirMode?: number;
    chmodDir?: boolean;
    mode?: number;
    syncTempFile?: boolean;
    syncParentDir?: boolean;
};
export type WriteSiblingTempFileResult<T> = {
    filePath: string;
    result: T;
};
export declare function writeSiblingTempFile<T>(options: WriteSiblingTempFileOptions<T>): Promise<WriteSiblingTempFileResult<T>>;
export declare function writeViaSiblingTempPath(params: {
    rootDir: string;
    targetPath: string;
    writeTemp: (tempPath: string) => Promise<void>;
    fallbackFileName?: string;
    tempPrefix?: string;
}): Promise<void>;
//# sourceMappingURL=sibling-temp.d.ts.map