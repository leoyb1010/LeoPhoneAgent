type SecureDirStat = {
    isDirectory(): boolean;
    isSymbolicLink(): boolean;
    mode?: number;
    uid?: number;
};
export type ResolveSecureTempRootOptions = {
    accessSync?: (path: string, mode?: number) => void;
    chmodSync?: (path: string, mode: number) => void;
    fallbackPrefix: string;
    getuid?: () => number | undefined;
    lstatSync?: (path: string) => SecureDirStat;
    mkdirSync?: (path: string, opts: {
        recursive: boolean;
        mode?: number;
    }) => void;
    platform?: NodeJS.Platform;
    preferredDir?: string;
    skipPreferredOnWindows?: boolean;
    tmpdir?: () => string;
    unsafeFallbackLabel?: string;
    warn?: (message: string) => void;
    warningPrefix?: string;
};
export declare function resolveSecureTempRoot(options: ResolveSecureTempRootOptions): string;
export {};
//# sourceMappingURL=secure-temp-dir.d.ts.map