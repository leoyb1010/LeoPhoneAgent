import { type RootPathAliasPolicy } from "./root-path.js";
export type PathAliasPolicy = RootPathAliasPolicy;
export declare const PATH_ALIAS_POLICIES: {
    readonly strict: Readonly<{
        allowFinalSymlinkForUnlink: false;
        allowFinalHardlinkForUnlink: false;
    }>;
    readonly unlinkTarget: Readonly<{
        allowFinalSymlinkForUnlink: true;
        allowFinalHardlinkForUnlink: true;
    }>;
};
export declare function assertNoPathAliasEscape(params: {
    absolutePath: string;
    rootPath: string;
    boundaryLabel: string;
    policy?: PathAliasPolicy;
}): Promise<void>;
export declare function assertNoHardlinkedFinalPath(params: {
    filePath: string;
    root: string;
    boundaryLabel: string;
    allowFinalHardlinkForUnlink?: boolean;
}): Promise<void>;
//# sourceMappingURL=path-policy.d.ts.map