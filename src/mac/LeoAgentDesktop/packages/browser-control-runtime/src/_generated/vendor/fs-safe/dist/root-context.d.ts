export type RootContext = {
    rootDir: string;
    rootReal: string;
    rootWithSep: string;
};
export declare const ensureTrailingSep: (value: string) => string;
export declare function assertValidRootRelativePath(relativePath: string): void;
export declare function expandRelativePathWithHome(relativePath: string): Promise<string>;
export declare function resolveRootContext(rootDir: string): Promise<RootContext>;
export declare function resolvePathInRoot(root: RootContext, relativePath: string): Promise<{
    rootReal: string;
    rootWithSep: string;
    resolved: string;
}>;
export declare function resolvePathWithinRoot(params: {
    rootDir: string;
    relativePath: string;
}): Promise<{
    rootReal: string;
    rootWithSep: string;
    resolved: string;
}>;
//# sourceMappingURL=root-context.d.ts.map