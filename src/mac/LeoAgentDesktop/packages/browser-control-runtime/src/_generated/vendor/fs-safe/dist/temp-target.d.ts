export type TempFile = {
    dir: string;
    path: string;
    file(fileName?: string): string;
    cleanup: () => Promise<void>;
    [Symbol.asyncDispose](): Promise<void>;
};
export declare function sanitizeTempFileName(fileName: string): string;
export declare function buildRandomTempFilePath(params: {
    rootDir?: string;
    prefix: string;
    extension?: string;
    now?: number;
    uuid?: string;
}): string;
export declare function tempFile(params: {
    rootDir?: string;
    prefix: string;
    fileName?: string;
    onCleanupError?: (error: unknown) => void;
}): Promise<TempFile>;
export declare function withTempFile<T>(params: {
    rootDir?: string;
    prefix: string;
    fileName?: string;
    onCleanupError?: (error: unknown) => void;
}, fn: (tmpPath: string) => Promise<T>): Promise<T>;
//# sourceMappingURL=temp-target.d.ts.map