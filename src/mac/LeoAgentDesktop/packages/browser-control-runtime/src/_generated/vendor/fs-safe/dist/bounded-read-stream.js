import { Transform } from "node:stream";
import { FsSafeError } from "./errors.js";
export function createMaxBytesTransform(maxBytes) {
    let bytes = 0;
    return new Transform({
        transform(chunk, _encoding, callback) {
            const buffer = chunk instanceof Buffer ? chunk : Buffer.from(chunk);
            bytes += buffer.byteLength;
            if (bytes > maxBytes) {
                callback(new FsSafeError("too-large", `file exceeds limit of ${maxBytes} bytes (got at least ${bytes})`));
                return;
            }
            callback(null, buffer);
        },
    });
}
export function createBoundedReadStream(opened, maxBytes) {
    const stream = opened.handle.createReadStream();
    return maxBytes === undefined ? stream : stream.pipe(createMaxBytesTransform(maxBytes));
}
