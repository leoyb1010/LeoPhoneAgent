export type AssertNoSymlinkParentsOptions = {
    rootDir: string;
    targetPath: string;
    allowMissing?: boolean;
    allowOutsideRoot?: boolean;
    allowRootChildSymlink?: boolean;
    requireDirectories?: boolean;
    messagePrefix?: string;
};
export declare function assertNoSymlinkParents(params: AssertNoSymlinkParentsOptions): Promise<void>;
export declare function assertNoSymlinkParentsSync(params: AssertNoSymlinkParentsOptions): void;
//# sourceMappingURL=symlink-parents.d.ts.map