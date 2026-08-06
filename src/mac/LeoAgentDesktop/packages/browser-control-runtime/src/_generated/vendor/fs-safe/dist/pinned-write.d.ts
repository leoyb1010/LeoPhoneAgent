import type { Readable } from "node:stream";
import type { FileIdentityStat } from "./file-identity.js";
type PinnedWriteInput = {
    kind: "buffer";
    data: string | Buffer;
    encoding?: BufferEncoding;
} | {
    kind: "stream";
    stream: Readable;
};
export declare function runPinnedWriteHelper(params: {
    rootPath: string;
    relativeParentPath: string;
    basename: string;
    mkdir: boolean;
    mode: number;
    overwrite?: boolean;
    maxBytes?: number;
    input: PinnedWriteInput;
    rootIdentity?: FileIdentityStat;
}): Promise<FileIdentityStat>;
export declare function runPinnedCopyHelper(params: {
    rootPath: string;
    relativeParentPath: string;
    basename: string;
    mkdir: boolean;
    mode: number;
    overwrite?: boolean;
    maxBytes?: number;
    sourcePath: string;
    sourceIdentity: FileIdentityStat;
    rootIdentity?: FileIdentityStat;
}): Promise<FileIdentityStat>;
export {};
//# sourceMappingURL=pinned-write.d.ts.map