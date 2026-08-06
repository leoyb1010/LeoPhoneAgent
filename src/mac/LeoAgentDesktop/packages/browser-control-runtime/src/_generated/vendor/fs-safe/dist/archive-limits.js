import { Transform } from "node:stream";
export const DEFAULT_MAX_ARCHIVE_BYTES_ZIP = 256 * 1024 * 1024;
export const DEFAULT_MAX_ENTRIES = 50_000;
export const DEFAULT_MAX_EXTRACTED_BYTES = 512 * 1024 * 1024;
export const DEFAULT_MAX_ENTRY_BYTES = 256 * 1024 * 1024;
export const ARCHIVE_LIMIT_ERROR_CODE = {
    ARCHIVE_SIZE_EXCEEDS_LIMIT: "archive-size-exceeds-limit",
    ENTRY_COUNT_EXCEEDS_LIMIT: "archive-entry-count-exceeds-limit",
    ENTRY_EXTRACTED_SIZE_EXCEEDS_LIMIT: "archive-entry-extracted-size-exceeds-limit",
    EXTRACTED_SIZE_EXCEEDS_LIMIT: "archive-extracted-size-exceeds-limit",
};
const ARCHIVE_LIMIT_ERROR_MESSAGE = {
    [ARCHIVE_LIMIT_ERROR_CODE.ARCHIVE_SIZE_EXCEEDS_LIMIT]: "archive size exceeds limit",
    [ARCHIVE_LIMIT_ERROR_CODE.ENTRY_COUNT_EXCEEDS_LIMIT]: "archive entry count exceeds limit",
    [ARCHIVE_LIMIT_ERROR_CODE.ENTRY_EXTRACTED_SIZE_EXCEEDS_LIMIT]: "archive entry extracted size exceeds limit",
    [ARCHIVE_LIMIT_ERROR_CODE.EXTRACTED_SIZE_EXCEEDS_LIMIT]: "archive extracted size exceeds limit",
};
export class ArchiveLimitError extends Error {
    code;
    constructor(code) {
        super(ARCHIVE_LIMIT_ERROR_MESSAGE[code]);
        this.name = "ArchiveLimitError";
        this.code = code;
    }
}
function clampLimit(value) {
    if (typeof value !== "number" || !Number.isFinite(value)) {
        return undefined;
    }
    const v = Math.floor(value);
    return v > 0 ? v : undefined;
}
export function resolveExtractLimits(limits) {
    // Defaults: defensive, but should not break normal installs.
    return {
        maxArchiveBytes: clampLimit(limits?.maxArchiveBytes) ?? DEFAULT_MAX_ARCHIVE_BYTES_ZIP,
        maxEntries: clampLimit(limits?.maxEntries) ?? DEFAULT_MAX_ENTRIES,
        maxExtractedBytes: clampLimit(limits?.maxExtractedBytes) ?? DEFAULT_MAX_EXTRACTED_BYTES,
        maxEntryBytes: clampLimit(limits?.maxEntryBytes) ?? DEFAULT_MAX_ENTRY_BYTES,
    };
}
export function assertArchiveEntryCountWithinLimit(entryCount, limits) {
    if (entryCount > limits.maxEntries) {
        throw new ArchiveLimitError(ARCHIVE_LIMIT_ERROR_CODE.ENTRY_COUNT_EXCEEDS_LIMIT);
    }
}
export function createByteBudgetTracker(limits) {
    let entryBytes = 0;
    let extractedBytes = 0;
    const addBytes = (bytes) => {
        const b = Math.max(0, Math.floor(bytes));
        if (b === 0) {
            return;
        }
        entryBytes += b;
        if (entryBytes > limits.maxEntryBytes) {
            throw new ArchiveLimitError(ARCHIVE_LIMIT_ERROR_CODE.ENTRY_EXTRACTED_SIZE_EXCEEDS_LIMIT);
        }
        extractedBytes += b;
        if (extractedBytes > limits.maxExtractedBytes) {
            throw new ArchiveLimitError(ARCHIVE_LIMIT_ERROR_CODE.EXTRACTED_SIZE_EXCEEDS_LIMIT);
        }
    };
    return {
        startEntry() {
            entryBytes = 0;
        },
        addBytes,
        addEntrySize(size) {
            const s = Math.max(0, Math.floor(size));
            if (s > limits.maxEntryBytes) {
                throw new ArchiveLimitError(ARCHIVE_LIMIT_ERROR_CODE.ENTRY_EXTRACTED_SIZE_EXCEEDS_LIMIT);
            }
            // Tar budgets are based on the header-declared size.
            addBytes(s);
        },
    };
}
export function createExtractBudgetTransform(params) {
    return new Transform({
        transform(chunk, _encoding, callback) {
            try {
                const buf = chunk instanceof Buffer ? chunk : Buffer.from(chunk);
                params.onChunkBytes(buf.byteLength);
                callback(null, buf);
            }
            catch (err) {
                callback(err instanceof Error ? err : new Error(String(err)));
            }
        },
    });
}
