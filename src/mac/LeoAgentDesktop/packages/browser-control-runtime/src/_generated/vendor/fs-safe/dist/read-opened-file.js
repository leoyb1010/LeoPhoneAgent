import { FsSafeError } from "./errors.js";
export async function readOpenedFileSafely(params) {
    if (params.maxBytes !== undefined && params.opened.stat.size > params.maxBytes) {
        throw new FsSafeError("too-large", `file exceeds limit of ${params.maxBytes} bytes (got ${params.opened.stat.size})`);
    }
    const buffer = await params.opened.handle.readFile();
    if (params.maxBytes !== undefined && buffer.byteLength > params.maxBytes) {
        throw new FsSafeError("too-large", `file exceeds limit of ${params.maxBytes} bytes (got ${buffer.byteLength})`);
    }
    return {
        buffer,
        realPath: params.opened.realPath,
        stat: params.opened.stat,
    };
}
