import type { Stats } from "node:fs";
import type { FileHandle } from "node:fs/promises";
export type ReadResult = {
    buffer: Buffer;
    realPath: string;
    stat: Stats;
};
type OpenedFile = {
    handle: FileHandle;
    realPath: string;
    stat: Stats;
};
export declare function readOpenedFileSafely(params: {
    opened: OpenedFile;
    maxBytes?: number;
}): Promise<ReadResult>;
export {};
//# sourceMappingURL=read-opened-file.d.ts.map