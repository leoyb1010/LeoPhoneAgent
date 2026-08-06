type InvalidPathResult = {
    ok: false;
    error: string;
};
type ResolvePathsWithinRootParams = {
    rootDir: string;
    requestedPaths: string[];
    scopeLabel: string;
};
type ResolvePathsWithinRootResult = {
    ok: true;
    paths: string[];
} | InvalidPathResult;
export type PathScopeResolveOptions = {
    defaultName?: string;
};
export type PathScopeOptions = {
    label: string;
};
export type PathScope = {
    rootDir: string;
    label: string;
    resolve(requestedPath: string, options?: PathScopeResolveOptions): {
        ok: true;
        path: string;
    } | {
        ok: false;
        error: string;
    };
    resolveAll(requestedPaths: string[]): ResolvePathsWithinRootResult;
    existing(requestedPaths: string[]): Promise<ResolvePathsWithinRootResult>;
    files(requestedPaths: string[]): Promise<ResolvePathsWithinRootResult>;
    writable(requestedPath: string, options?: PathScopeResolveOptions): Promise<{
        ok: true;
        path: string;
    } | {
        ok: false;
        error: string;
    }>;
    ensureDir(requestedPath: string, options?: PathScopeResolveOptions & {
        mode?: number;
    }): Promise<{
        ok: true;
        path: string;
    } | {
        ok: false;
        error: string;
    }>;
};
export declare function resolvePathWithinRoot(params: {
    rootDir: string;
    requestedPath: string;
    scopeLabel: string;
    defaultFileName?: string;
}): {
    ok: true;
    path: string;
} | {
    ok: false;
    error: string;
};
export declare function resolveWritablePathWithinRoot(params: {
    rootDir: string;
    requestedPath: string;
    scopeLabel: string;
    defaultFileName?: string;
}): Promise<{
    ok: true;
    path: string;
} | {
    ok: false;
    error: string;
}>;
export declare function ensureDirectoryWithinRoot(params: {
    rootDir: string;
    requestedPath: string;
    scopeLabel: string;
    defaultDirName?: string;
    mode?: number;
}): Promise<{
    ok: true;
    path: string;
} | {
    ok: false;
    error: string;
}>;
export declare function resolvePathsWithinRoot(params: ResolvePathsWithinRootParams): ResolvePathsWithinRootResult;
export declare function resolveExistingPathsWithinRoot(params: ResolvePathsWithinRootParams): Promise<ResolvePathsWithinRootResult>;
export declare function resolveStrictExistingPathsWithinRoot(params: ResolvePathsWithinRootParams): Promise<ResolvePathsWithinRootResult>;
export declare function pathScope(rootDir: string, options: PathScopeOptions): PathScope;
export {};
//# sourceMappingURL=root-paths.d.ts.map