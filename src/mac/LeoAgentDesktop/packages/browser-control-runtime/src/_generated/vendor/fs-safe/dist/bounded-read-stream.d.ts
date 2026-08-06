import { Transform } from "node:stream";
export declare function createMaxBytesTransform(maxBytes: number): Transform;
export declare function createBoundedReadStream(opened: {
    handle: {
        createReadStream(): NodeJS.ReadableStream;
    };
}, maxBytes: number | undefined): NodeJS.ReadableStream;
//# sourceMappingURL=bounded-read-stream.d.ts.map