import { FsSafeError } from "./errors.js";
const SAFE_PATH_SEGMENT_PATTERN = /^[A-Za-z0-9_-][A-Za-z0-9._-]*$/;
const SAFE_DOT_PREFIX_PATH_SEGMENT_PATTERN = /^[A-Za-z0-9._-]+$/;
export function isSafePathSegment(segment, options = {}) {
    return (segment !== "" &&
        segment !== "." &&
        segment !== ".." &&
        !segment.includes("/") &&
        !segment.includes("\\") &&
        !segment.includes("\0") &&
        (options.allowDotPrefix === true || !segment.startsWith(".")) &&
        (options.allowDotPrefix === true
            ? SAFE_DOT_PREFIX_PATH_SEGMENT_PATTERN.test(segment)
            : SAFE_PATH_SEGMENT_PATTERN.test(segment)));
}
export function assertSafePathSegment(segment, options = {}) {
    // Validate the exact value callers will later join into paths; trimming here
    // would let whitespace-padded ids pass and then be used verbatim.
    if (!isSafePathSegment(segment, options)) {
        throw new FsSafeError("invalid-path", `${options.label ?? "path segment"} must be a safe path segment`);
    }
    return segment;
}
export function sanitizeSafePathSegment(value, fallback, options = {}) {
    const sanitized = value
        .trim()
        .replace(/[\\/]+/g, "-")
        .replace(/\0/g, "")
        .replace(/[^A-Za-z0-9._-]+/g, "-")
        .replace(/^-+|-+$/g, "");
    if (isSafePathSegment(sanitized, options)) {
        return sanitized;
    }
    return assertSafePathSegment(fallback, { ...options, label: "fallback path segment" });
}
export function assertSafePathPrefix(prefix, options = {}) {
    // Prefixes are often derived from safe filenames. Normalize harmless
    // filename characters first, but still reject real path-control bytes.
    if (prefix.includes("/") || prefix.includes("\\") || prefix.includes("\0")) {
        return assertSafePathSegment(prefix, {
            allowDotPrefix: true,
            ...options,
            label: options.label ?? "path prefix",
        });
    }
    return assertSafePathSegment(prefix.replace(/[^A-Za-z0-9._-]+/g, "-"), {
        allowDotPrefix: true,
        ...options,
        label: options.label ?? "path prefix",
    });
}
