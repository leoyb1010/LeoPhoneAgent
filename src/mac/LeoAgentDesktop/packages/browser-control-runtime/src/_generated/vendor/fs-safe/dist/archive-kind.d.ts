export type ArchiveKind = "tar" | "zip";
export declare function resolveArchiveKind(filePath: string): ArchiveKind | null;
type ResolvePackedRootDirOptions = {
    rootMarkers?: string[];
};
export declare function resolvePackedRootDir(extractDir: string, options?: ResolvePackedRootDirOptions): Promise<string>;
export {};
//# sourceMappingURL=archive-kind.d.ts.map