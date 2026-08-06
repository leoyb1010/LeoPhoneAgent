export declare const DEFAULT_SECRET_FILE_MAX_BYTES: number;
export declare const PRIVATE_SECRET_DIR_MODE = 448;
export declare const PRIVATE_SECRET_FILE_MODE = 384;
export type SecretFileReadOptions = {
    maxBytes?: number;
    rejectSymlink?: boolean;
    rejectHardlinks?: boolean;
};
export declare function readSecretFileSync(filePath: string, label: string, options?: SecretFileReadOptions): string;
export declare function tryReadSecretFileSync(filePath: string | undefined, label: string, options?: SecretFileReadOptions): string | undefined;
export declare function writeSecretFileAtomic(params: {
    rootDir: string;
    filePath: string;
    content: string | Uint8Array;
    mode?: number;
    dirMode?: number;
}): Promise<void>;
//# sourceMappingURL=secret-file.d.ts.map