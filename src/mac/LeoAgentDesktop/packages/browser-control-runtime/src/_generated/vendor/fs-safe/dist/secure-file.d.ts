import type { Stats } from "node:fs";
import { type PermissionCheck, type PermissionCheckOptions } from "./permissions.js";
export type SecureFileReadOptions = {
    filePath: string;
    label?: string;
    trust?: SecureFileTrustOptions;
    permissions?: SecureFilePermissionOptions;
    inject?: SecureFileInjectOptions;
    io?: SecureFileIoOptions;
};
export type SecureFileTrustOptions = {
    trustedDirs?: string[];
    allowSymlink?: boolean;
    allowNetworkPath?: boolean;
};
export type SecureFilePermissionOptions = {
    allowInsecure?: boolean;
    allowReadableByOthers?: boolean;
};
export type SecureFileInjectOptions = PermissionCheckOptions;
export type SecureFileIoOptions = {
    maxBytes?: number;
    timeoutMs?: number;
};
export type SecureFileReadResult = {
    buffer: Buffer;
    realPath: string;
    stat: Stats;
    permissions?: PermissionCheck;
};
export declare function readSecureFile(options: SecureFileReadOptions): Promise<SecureFileReadResult>;
//# sourceMappingURL=secure-file.d.ts.map