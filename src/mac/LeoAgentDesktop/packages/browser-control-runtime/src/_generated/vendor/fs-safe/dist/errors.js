const OPERATIONAL_CODES = new Set([
    "helper-failed",
    "helper-unavailable",
    "permission-unverified",
    "timeout",
    "unsupported-platform",
]);
export function categorizeFsSafeError(code) {
    return OPERATIONAL_CODES.has(code) ? "operational" : "policy";
}
export class FsSafeError extends Error {
    code;
    category;
    constructor(code, message, options = {}) {
        super(message, options);
        this.name = "FsSafeError";
        this.code = code;
        this.category = categorizeFsSafeError(code);
    }
}
