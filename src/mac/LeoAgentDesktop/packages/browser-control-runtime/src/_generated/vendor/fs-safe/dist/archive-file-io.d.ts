import type { FileHandle } from "node:fs/promises";
import type { ExtractionDeadline } from "./archive-deadline.js";
export declare function writeFileHandleFully(params: {
    handle: FileHandle;
    buffer: Buffer;
    bytes: number;
    deadline: ExtractionDeadline;
}): Promise<void>;
//# sourceMappingURL=archive-file-io.d.ts.map