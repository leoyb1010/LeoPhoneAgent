import { type HardlinkPolicy, type ReadResult, type SymlinkPolicy } from "./root.js";
export type LocalRootsPathResult = {
    path: string;
    root: string;
};
export type LocalRootsReadResult = ReadResult & {
    root: string;
};
export type LocalRootsInputOptions = {
    filePath: string;
    roots: readonly string[];
    label?: string;
};
export type ResolveLocalPathFromRootsSyncOptions = LocalRootsInputOptions & {
    allowMissing?: boolean;
    requireFile?: boolean;
};
export type ReadLocalFileFromRootsOptions = LocalRootsInputOptions & {
    hardlinks?: HardlinkPolicy;
    maxBytes?: number;
    nonBlockingRead?: boolean;
    symlinks?: SymlinkPolicy;
};
export declare function resolveLocalPathFromRootsSync(options: ResolveLocalPathFromRootsSyncOptions): LocalRootsPathResult | null;
export declare function readLocalFileFromRoots(options: ReadLocalFileFromRootsOptions): Promise<LocalRootsReadResult | null>;
//# sourceMappingURL=local-roots.d.ts.map