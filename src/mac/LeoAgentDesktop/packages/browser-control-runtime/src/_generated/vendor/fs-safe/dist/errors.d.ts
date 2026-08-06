export type FsSafeErrorCode = "already-exists" | "denied-path" | "device-path" | "hardlink" | "helper-failed" | "helper-unavailable" | "invalid-path" | "insecure-permissions" | "not-empty" | "not-file" | "not-found" | "not-owned" | "not-removable" | "outside-workspace" | "path-alias" | "path-mismatch" | "permission-unverified" | "symlink" | "timeout" | "too-large" | "unsupported-platform";
export type FsSafeErrorCategory = "policy" | "operational";
export declare function categorizeFsSafeError(code: FsSafeErrorCode): FsSafeErrorCategory;
export declare class FsSafeError extends Error {
    readonly code: FsSafeErrorCode;
    readonly category: FsSafeErrorCategory;
    constructor(code: FsSafeErrorCode, message: string, options?: {
        cause?: unknown;
    });
}
//# sourceMappingURL=errors.d.ts.map