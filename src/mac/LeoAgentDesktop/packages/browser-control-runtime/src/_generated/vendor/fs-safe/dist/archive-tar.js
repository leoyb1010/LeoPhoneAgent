import { resolveArchiveOutputPath, stripArchivePath, validateArchiveEntryPath, } from "./archive-entry.js";
import { assertArchiveEntryCountWithinLimit, createByteBudgetTracker, resolveExtractLimits, } from "./archive-limits.js";
const BLOCKED_TAR_ENTRY_TYPES = new Set([
    "SymbolicLink",
    "Link",
    "BlockDevice",
    "CharacterDevice",
    "FIFO",
    "Socket",
]);
export function readTarEntryInfo(entry) {
    const p = typeof entry === "object" && entry !== null && "path" in entry
        ? String(entry.path)
        : "";
    const t = typeof entry === "object" && entry !== null && "type" in entry
        ? String(entry.type)
        : "";
    const s = typeof entry === "object" &&
        entry !== null &&
        "size" in entry &&
        typeof entry.size === "number" &&
        Number.isFinite(entry.size)
        ? Math.max(0, Math.floor(entry.size))
        : 0;
    return { path: p, type: t, size: s };
}
export function createTarEntryPreflightChecker(params) {
    const strip = Math.max(0, Math.floor(params.stripComponents ?? 0));
    const limits = resolveExtractLimits(params.limits);
    let entryCount = 0;
    const budget = createByteBudgetTracker(limits);
    return (entry) => {
        validateArchiveEntryPath(entry.path, { escapeLabel: params.escapeLabel });
        const relPath = stripArchivePath(entry.path, strip);
        if (!relPath) {
            return;
        }
        validateArchiveEntryPath(relPath, { escapeLabel: params.escapeLabel });
        resolveArchiveOutputPath({
            rootDir: params.rootDir,
            relPath,
            originalPath: entry.path,
            escapeLabel: params.escapeLabel,
        });
        if (BLOCKED_TAR_ENTRY_TYPES.has(entry.type)) {
            throw new Error(`tar entry is a link: ${entry.path}`);
        }
        entryCount += 1;
        assertArchiveEntryCountWithinLimit(entryCount, limits);
        budget.addEntrySize(entry.size);
    };
}
