import path from "node:path";
import { FsSafeError } from "./errors.js";
import { trySafeFileURLToPath } from "./local-file-access.js";
const POSIX_BLOCKED_DEVICE_PATHS = new Set([
    "/dev/zero",
    "/dev/random",
    "/dev/urandom",
    "/dev/full",
    "/dev/stdin",
    "/dev/stdout",
    "/dev/stderr",
    "/dev/tty",
    "/dev/console",
]);
const WINDOWS_RESERVED_DEVICE_NAMES = new Set([
    "CON",
    "PRN",
    "AUX",
    "NUL",
    "CLOCK$",
    "CONIN$",
    "CONOUT$",
    "COM1",
    "COM2",
    "COM3",
    "COM4",
    "COM5",
    "COM6",
    "COM7",
    "COM8",
    "COM9",
    "COM¹",
    "COM²",
    "COM³",
    "LPT1",
    "LPT2",
    "LPT3",
    "LPT4",
    "LPT5",
    "LPT6",
    "LPT7",
    "LPT8",
    "LPT9",
    "LPT¹",
    "LPT²",
    "LPT³",
]);
function candidateReadPaths(filePath) {
    if (!filePath.startsWith("file://")) {
        return [filePath];
    }
    const parsed = trySafeFileURLToPath(filePath);
    return parsed === undefined ? [filePath] : [filePath, parsed];
}
function normalizePosixPath(filePath, cwd) {
    if (path.posix.isAbsolute(filePath)) {
        return path.posix.normalize(filePath);
    }
    const base = cwd && path.posix.isAbsolute(cwd) ? cwd : process.cwd();
    return path.posix.resolve(base, filePath);
}
function matchPosixDeviceReadPath(filePath, cwd) {
    const normalized = normalizePosixPath(filePath, cwd);
    if (POSIX_BLOCKED_DEVICE_PATHS.has(normalized)) {
        return { path: normalized, reason: "posix-device" };
    }
    if (normalized === "/dev/fd" || normalized.startsWith("/dev/fd/")) {
        return { path: normalized, reason: "posix-fd" };
    }
    if (/^\/proc\/(?:self|thread-self|\d+)\/fd(?:\/|$)/.test(normalized)) {
        return { path: normalized, reason: "posix-fd" };
    }
    return undefined;
}
function normalizeWindowsDeviceBaseName(filePath) {
    const normalized = filePath.replace(/\//g, "\\").replace(/[\\]+$/g, "");
    const lastSegment = normalized.split("\\").filter(Boolean).at(-1) ?? normalized;
    const withoutStream = lastSegment.split(":")[0] ?? lastSegment;
    const withoutTrailingIgnoredChars = withoutStream.replace(/[ .]+$/g, "");
    return (withoutTrailingIgnoredChars.split(".")[0] ?? withoutTrailingIgnoredChars).toUpperCase();
}
function matchWindowsDeviceReadPath(filePath) {
    const normalized = filePath.replace(/\//g, "\\");
    if (/^\\\\\.\\/.test(normalized) || /^\\\\\?\\GLOBALROOT\\Device\\/i.test(normalized)) {
        return { path: normalized, reason: "windows-device" };
    }
    const baseName = normalizeWindowsDeviceBaseName(filePath);
    if (WINDOWS_RESERVED_DEVICE_NAMES.has(baseName)) {
        return { path: normalized, reason: "windows-device" };
    }
    return undefined;
}
export function matchUnsafeDeviceReadPath(filePath, options = {}) {
    const platform = options.platform ?? process.platform;
    for (const candidate of candidateReadPaths(filePath)) {
        const match = platform === "win32"
            ? matchWindowsDeviceReadPath(candidate)
            : matchPosixDeviceReadPath(candidate, options.cwd);
        if (match) {
            return match;
        }
    }
    return undefined;
}
export function isUnsafeDeviceReadPath(filePath, options) {
    return matchUnsafeDeviceReadPath(filePath, options) !== undefined;
}
export function assertNoUnsafeDeviceReadPath(filePath, options) {
    if (matchUnsafeDeviceReadPath(filePath, options)) {
        throw new FsSafeError("device-path", `file reads from unsafe device paths are not allowed: ${filePath}`);
    }
}
