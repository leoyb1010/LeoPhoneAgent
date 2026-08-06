import { Transform } from "node:stream";
export type ArchiveExtractLimits = {
    /**
     * Max archive file bytes (compressed).
     */
    maxArchiveBytes?: number;
    /** Max number of extracted entries (files + dirs). */
    maxEntries?: number;
    /** Max extracted bytes (sum of all files). */
    maxExtractedBytes?: number;
    /** Max extracted bytes for a single file entry. */
    maxEntryBytes?: number;
};
export declare const DEFAULT_MAX_ARCHIVE_BYTES_ZIP: number;
export declare const DEFAULT_MAX_ENTRIES = 50000;
export declare const DEFAULT_MAX_EXTRACTED_BYTES: number;
export declare const DEFAULT_MAX_ENTRY_BYTES: number;
export declare const ARCHIVE_LIMIT_ERROR_CODE: {
    readonly ARCHIVE_SIZE_EXCEEDS_LIMIT: "archive-size-exceeds-limit";
    readonly ENTRY_COUNT_EXCEEDS_LIMIT: "archive-entry-count-exceeds-limit";
    readonly ENTRY_EXTRACTED_SIZE_EXCEEDS_LIMIT: "archive-entry-extracted-size-exceeds-limit";
    readonly EXTRACTED_SIZE_EXCEEDS_LIMIT: "archive-extracted-size-exceeds-limit";
};
export type ArchiveLimitErrorCode = (typeof ARCHIVE_LIMIT_ERROR_CODE)[keyof typeof ARCHIVE_LIMIT_ERROR_CODE];
export declare class ArchiveLimitError extends Error {
    readonly code: ArchiveLimitErrorCode;
    constructor(code: ArchiveLimitErrorCode);
}
export type ResolvedArchiveExtractLimits = Required<ArchiveExtractLimits>;
export declare function resolveExtractLimits(limits?: ArchiveExtractLimits): ResolvedArchiveExtractLimits;
export declare function assertArchiveEntryCountWithinLimit(entryCount: number, limits: ResolvedArchiveExtractLimits): void;
export declare function createByteBudgetTracker(limits: ResolvedArchiveExtractLimits): {
    startEntry: () => void;
    addBytes: (bytes: number) => void;
    addEntrySize: (size: number) => void;
};
export declare function createExtractBudgetTransform(params: {
    onChunkBytes: (bytes: number) => void;
}): Transform;
//# sourceMappingURL=archive-limits.d.ts.map