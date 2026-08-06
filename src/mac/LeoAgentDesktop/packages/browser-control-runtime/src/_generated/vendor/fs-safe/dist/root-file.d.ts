import fs from "node:fs";
import type { PathAliasPolicy } from "./path-policy.js";
import { type PinnedOpenSyncAllowedType, type PinnedOpenSyncFailureReason } from "./pinned-open.js";
type BoundaryReadFs = Pick<typeof fs, "closeSync" | "constants" | "fstatSync" | "lstatSync" | "openSync" | "readFileSync" | "realpathSync">;
export type RootFileOpenFailureReason = PinnedOpenSyncFailureReason | "validation";
export type RootFileOpenResult = {
    ok: true;
    path: string;
    fd: number;
    stat: fs.Stats;
    rootRealPath: string;
} | {
    ok: false;
    reason: RootFileOpenFailureReason;
    error?: unknown;
};
export type RootFileOpenFailure = Extract<RootFileOpenResult, {
    ok: false;
}>;
export type OpenRootFileSyncParams = {
    absolutePath: string;
    rootPath: string;
    boundaryLabel: string;
    rootRealPath?: string;
    maxBytes?: number;
    rejectHardlinks?: boolean;
    allowedType?: PinnedOpenSyncAllowedType;
    skipLexicalRootCheck?: boolean;
    ioFs?: BoundaryReadFs;
};
export type OpenRootFileParams = OpenRootFileSyncParams & {
    aliasPolicy?: PathAliasPolicy;
};
export declare function canUseRootFileOpen(ioFs: typeof fs): boolean;
export declare function openRootFileSync(params: OpenRootFileSyncParams): RootFileOpenResult;
export declare function matchRootFileOpenFailure<T>(failure: RootFileOpenFailure, handlers: {
    path?: (failure: RootFileOpenFailure) => T;
    validation?: (failure: RootFileOpenFailure) => T;
    io?: (failure: RootFileOpenFailure) => T;
    fallback: (failure: RootFileOpenFailure) => T;
}): T;
export declare function openRootFile(params: OpenRootFileParams): Promise<RootFileOpenResult>;
export {};
//# sourceMappingURL=root-file.d.ts.map