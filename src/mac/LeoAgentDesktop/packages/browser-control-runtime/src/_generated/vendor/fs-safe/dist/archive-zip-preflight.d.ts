import { type ArchiveExtractLimits } from "./archive-limits.js";
export type ZipArchiveWithFiles = {
    files: Record<string, unknown>;
};
export declare function readZipCentralDirectoryEntryCount(buffer: Buffer | Uint8Array): number | null;
export declare function loadZipArchiveWithPreflight(buffer: Buffer | Uint8Array, limits?: ArchiveExtractLimits): Promise<ZipArchiveWithFiles>;
//# sourceMappingURL=archive-zip-preflight.d.ts.map