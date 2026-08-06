export type ExternalFileWriteOptions<T = void> = {
    rootDir: string;
    path: string;
    write: (filePath: string) => Promise<T>;
    maxBytes?: number;
    mode?: number;
};
export type ExternalFileWriteResult<T = void> = {
    path: string;
    result: T;
};
export declare function writeExternalFileWithinRoot<T = void>(options: ExternalFileWriteOptions<T>): Promise<ExternalFileWriteResult<T>>;
//# sourceMappingURL=output.d.ts.map