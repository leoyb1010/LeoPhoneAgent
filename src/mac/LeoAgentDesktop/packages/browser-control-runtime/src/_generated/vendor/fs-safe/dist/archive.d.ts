import { type ArchiveExtractLimits } from "./archive-limits.js";
import { type ArchiveKind } from "./archive-kind.js";
export type ArchiveLogger = {
    info?: (message: string) => void;
    warn?: (message: string) => void;
};
export { isWindowsDrivePath, normalizeArchiveEntryPath, resolveArchiveOutputPath, stripArchivePath, validateArchiveEntryPath, } from "./archive-entry.js";
export { resolveArchiveKind, resolvePackedRootDir, type ArchiveKind } from "./archive-kind.js";
export { ARCHIVE_LIMIT_ERROR_CODE, ArchiveLimitError, DEFAULT_MAX_ARCHIVE_BYTES_ZIP, DEFAULT_MAX_ENTRIES, DEFAULT_MAX_EXTRACTED_BYTES, DEFAULT_MAX_ENTRY_BYTES, type ArchiveExtractLimits, type ArchiveLimitErrorCode, } from "./archive-limits.js";
export { ArchiveSecurityError, type ArchiveSecurityErrorCode } from "./archive-staging.js";
export { createArchiveSymlinkTraversalError, mergeExtractedTreeIntoDestination, prepareArchiveDestinationDir, prepareArchiveOutputPath, withStagedArchiveDestination, } from "./archive-staging.js";
export { createTarEntryPreflightChecker, type TarEntryInfo } from "./archive-tar.js";
export { loadZipArchiveWithPreflight, readZipCentralDirectoryEntryCount, type ZipArchiveWithFiles, } from "./archive-zip-preflight.js";
export declare function extractArchive(params: {
    archivePath: string;
    destDir: string;
    timeoutMs: number;
    kind?: ArchiveKind;
    stripComponents?: number;
    tarGzip?: boolean;
    limits?: ArchiveExtractLimits;
    logger?: ArchiveLogger;
}): Promise<void>;
//# sourceMappingURL=archive.d.ts.map