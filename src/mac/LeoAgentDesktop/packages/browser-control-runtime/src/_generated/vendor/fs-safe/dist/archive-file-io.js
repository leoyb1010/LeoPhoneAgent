export async function writeFileHandleFully(params) {
    let offset = 0;
    while (offset < params.bytes) {
        params.deadline.check();
        const { bytesWritten } = await params.handle.write(params.buffer, offset, params.bytes - offset);
        if (bytesWritten <= 0) {
            throw new Error("archive staging write made no progress");
        }
        offset += bytesWritten;
    }
}
