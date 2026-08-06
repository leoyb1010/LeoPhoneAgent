import path from "node:path";
import { FsSafeError } from "./errors.js";
import { sanitizeUntrustedFileName } from "./filename.js";
import { isPathInside } from "./path.js";
import { root } from "./root.js";
import { tempFile } from "./temp-target.js";
function tempFileNameForTarget(targetPath) {
    return sanitizeUntrustedFileName(path.basename(targetPath), "output.bin");
}
function ensureTrailingSep(value) {
    return value.endsWith(path.sep) ? value : `${value}${path.sep}`;
}
function toRootPathInput(params) {
    if (!path.isAbsolute(params.targetPath)) {
        return params.targetPath;
    }
    const absoluteTarget = path.resolve(params.targetPath);
    const rootDir = path.resolve(params.rootDir);
    if (isPathInside(ensureTrailingSep(rootDir), absoluteTarget)) {
        return path.relative(rootDir, absoluteTarget);
    }
    if (isPathInside(ensureTrailingSep(params.rootReal), absoluteTarget)) {
        return path.relative(params.rootReal, absoluteTarget);
    }
    return params.targetPath;
}
function assertFileTargetPath(targetPath) {
    const basename = path.basename(targetPath);
    if (!targetPath ||
        targetPath === "." ||
        targetPath.endsWith("/") ||
        targetPath.endsWith("\\") ||
        !basename ||
        basename === "." ||
        basename === "..") {
        throw new FsSafeError("invalid-path", "target path must name a file");
    }
}
export async function writeExternalFileWithinRoot(options) {
    const targetRoot = await root(options.rootDir);
    const requestedTargetPath = options.path;
    if (requestedTargetPath.length === 0) {
        throw new FsSafeError("invalid-path", "target path is required");
    }
    assertFileTargetPath(requestedTargetPath);
    const targetPath = toRootPathInput({
        rootDir: targetRoot.rootDir,
        rootReal: targetRoot.rootReal,
        targetPath: requestedTargetPath,
    });
    assertFileTargetPath(targetPath);
    const finalPath = await targetRoot.resolve(targetPath);
    const staged = await tempFile({
        prefix: "fs-safe-output",
        fileName: tempFileNameForTarget(targetPath),
    });
    try {
        const result = await options.write(staged.path);
        await targetRoot.copyIn(targetPath, staged.path, {
            maxBytes: options.maxBytes,
            mode: options.mode,
            mkdir: true,
            sourceHardlinks: "reject",
        });
        return { path: finalPath, result };
    }
    finally {
        await staged.cleanup();
    }
}
