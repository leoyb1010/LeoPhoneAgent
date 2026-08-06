import { type ArchiveExtractLimits } from "./archive-limits.js";
export type TarEntryInfo = {
    path: string;
    type: string;
    size: number;
};
export declare function readTarEntryInfo(entry: unknown): TarEntryInfo;
export declare function createTarEntryPreflightChecker(params: {
    rootDir: string;
    stripComponents?: number;
    limits?: ArchiveExtractLimits;
    escapeLabel?: string;
}): (entry: TarEntryInfo) => void;
//# sourceMappingURL=archive-tar.d.ts.map