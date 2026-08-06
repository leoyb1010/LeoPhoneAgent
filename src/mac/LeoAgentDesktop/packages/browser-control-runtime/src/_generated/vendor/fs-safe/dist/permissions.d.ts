export type PermissionExec = (command: string, args: string[]) => Promise<{
    stdout: string;
    stderr: string;
}>;
export type PermissionCheck = {
    ok: boolean;
    isSymlink: boolean;
    isDir: boolean;
    mode: number | null;
    bits: number | null;
    source: "posix" | "windows-acl" | "unknown";
    worldWritable: boolean;
    groupWritable: boolean;
    worldReadable: boolean;
    groupReadable: boolean;
    aclSummary?: string;
    error?: string;
};
export type PermissionCheckOptions = {
    platform?: NodeJS.Platform;
    env?: NodeJS.ProcessEnv;
    exec?: PermissionExec;
};
export type SafeStatResult = {
    ok: boolean;
    isSymlink: boolean;
    isDir: boolean;
    mode: number | null;
    uid: number | null;
    gid: number | null;
    error?: string;
};
export type WindowsAclEntry = {
    principal: string;
    rights: string[];
    rawRights: string;
    canRead: boolean;
    canWrite: boolean;
};
export type WindowsAclSummary = {
    ok: boolean;
    entries: WindowsAclEntry[];
    untrustedWorld: WindowsAclEntry[];
    untrustedGroup: WindowsAclEntry[];
    trusted: WindowsAclEntry[];
    error?: string;
};
export type WindowsUserInfoProvider = () => {
    username?: string | null;
};
export type IcaclsResetCommandOptions = {
    isDir: boolean;
    env?: NodeJS.ProcessEnv;
    userInfo?: WindowsUserInfoProvider;
};
export declare function safeStat(targetPath: string): Promise<SafeStatResult>;
export declare function inspectPathPermissions(targetPath: string, opts?: PermissionCheckOptions): Promise<PermissionCheck>;
export declare function formatPermissionDetail(targetPath: string, perms: PermissionCheck): string;
export declare function formatPermissionRemediation(params: {
    targetPath: string;
    perms: PermissionCheck;
    isDir: boolean;
    posixMode: number;
    env?: NodeJS.ProcessEnv;
}): string;
export declare function modeBits(mode: number | null): number | null;
export declare function formatOctal(bits: number | null): string;
export declare function isWorldWritable(bits: number | null): boolean;
export declare function isGroupWritable(bits: number | null): boolean;
export declare function isWorldReadable(bits: number | null): boolean;
export declare function isGroupReadable(bits: number | null): boolean;
export declare function resolveWindowsUserPrincipal(env?: NodeJS.ProcessEnv, userInfo?: WindowsUserInfoProvider): string | null;
export declare function parseIcaclsOutput(output: string, targetPath: string): WindowsAclEntry[];
export declare function summarizeWindowsAcl(entries: WindowsAclEntry[], env?: NodeJS.ProcessEnv): Pick<WindowsAclSummary, "trusted" | "untrustedWorld" | "untrustedGroup">;
export declare function inspectWindowsAcl(targetPath: string, opts?: {
    env?: NodeJS.ProcessEnv;
    exec?: PermissionExec;
}): Promise<WindowsAclSummary>;
export declare function formatWindowsAclSummary(summary: WindowsAclSummary): string;
export declare function formatIcaclsResetCommand(targetPath: string, opts: IcaclsResetCommandOptions): string;
export declare function createIcaclsResetCommand(targetPath: string, opts: IcaclsResetCommandOptions): {
    command: string;
    args: string[];
    display: string;
} | null;
//# sourceMappingURL=permissions.d.ts.map