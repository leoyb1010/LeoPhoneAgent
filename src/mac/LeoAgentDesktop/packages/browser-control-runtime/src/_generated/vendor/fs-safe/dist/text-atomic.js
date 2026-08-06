import { replaceFileAtomic } from "./replace-file.js";
export async function writeTextAtomic(filePath, content, options) {
    const payload = options?.trailingNewline && !content.endsWith("\n") ? `${content}\n` : content;
    const durable = options?.durable ?? true;
    await replaceFileAtomic({
        filePath,
        content: payload,
        mode: options?.mode ?? 0o600,
        dirMode: options?.dirMode ?? (0o777 & ~process.umask()),
        copyFallbackOnPermissionError: true,
        syncTempFile: durable,
        syncParentDir: durable,
    });
}
