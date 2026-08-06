import type { Stats } from "node:fs";
import fsSync from "node:fs";
export type RegularFileStatResult = {
    missing: true;
} | {
    missing: false;
    stat: Stats;
};
type RegularFileAppendFlagConstants = Pick<typeof fsSync.constants, "O_APPEND" | "O_CREAT" | "O_WRONLY"> & Partial<Pick<typeof fsSync.constants, "O_NOFOLLOW">>;
export type AppendRegularFileOptions = {
    filePath: string;
    content: string | Uint8Array;
    encoding?: BufferEncoding;
    maxFileBytes?: number;
    mode?: number;
    rejectSymlinkParents?: boolean;
};
export declare function resolveRegularFileAppendFlags(constants?: RegularFileAppendFlagConstants): number;
export declare function statRegularFile(filePath: string): Promise<RegularFileStatResult>;
export declare function statRegularFileSync(filePath: string): RegularFileStatResult;
export declare function readRegularFile(params: {
    filePath: string;
    maxBytes?: number;
}): Promise<{
    buffer: Buffer;
    stat: Stats;
}>;
export declare function readRegularFileSync(params: {
    filePath: string;
    maxBytes?: number;
}): {
    buffer: Buffer;
    stat: Stats;
};
export declare function appendRegularFile(options: AppendRegularFileOptions): Promise<void>;
export declare function appendRegularFileSync(options: AppendRegularFileOptions): void;
export {};
//# sourceMappingURL=regular-file.d.ts.map