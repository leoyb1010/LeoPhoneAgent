// Advanced composition surface. These exports are less stable than the focused
// public subpaths; prefer root/json/store/temp/archive unless you are building a
// higher-level primitive.
export { createAsyncLock } from "./async-lock.js";
export { assertNoUnsafeDeviceReadPath, isUnsafeDeviceReadPath, matchUnsafeDeviceReadPath, } from "./device-path.js";
export { assertAbsolutePathInput, canonicalPathFromExistingAncestor, ensureAbsoluteDirectory, findExistingAncestor, resolveAbsolutePathForRead, resolveAbsolutePathForWrite, } from "./absolute-path.js";
export { sameFileIdentity } from "./file-identity.js";
export { sanitizeUntrustedFileName } from "./filename.js";
export { pathExists, pathExistsSync } from "./fs.js";
export { resolveLocalPathFromRootsSync, readLocalFileFromRoots, } from "./local-roots.js";
export { assertNoWindowsNetworkPath, basenameFromMediaSource, hasEncodedFileUrlSeparator, isWindowsDriveLetterPath, isWindowsNetworkPath, safeFileURLToPath, trySafeFileURLToPath, } from "./local-file-access.js";
export { formatPosixMode } from "./mode.js";
export { configureFsSafeLocks, getFsSafeLockConfig, } from "./lock-config.js";
export { assertNoHardlinkedFinalPath, assertNoPathAliasEscape, PATH_ALIAS_POLICIES, } from "./path-policy.js";
export { openRootFile, openRootFileSync, canUseRootFileOpen, matchRootFileOpenFailure, } from "./root-file.js";
export { ROOT_PATH_ALIAS_POLICIES, resolvePathViaExistingAncestorSync, resolveRootPath, resolveRootPathSync, } from "./root-path.js";
export { ensureDirectoryWithinRoot, pathScope, resolveExistingPathsWithinRoot, resolvePathWithinRoot, resolvePathsWithinRoot, resolveStrictExistingPathsWithinRoot, resolveWritablePathWithinRoot, } from "./root-paths.js";
export { safeDirName, safePathSegmentHashed, resolveSafeInstallDir, assertCanonicalPathWithinBase, } from "./install-path.js";
export { assertNoSymlinkParents, assertNoSymlinkParentsSync, } from "./symlink-parents.js";
export { movePathToTrash } from "./trash.js";
export { withTimeout } from "./timing.js";
export { resolveHomeRelativePath } from "./home-dir.js";
export { appendRegularFile, appendRegularFileSync, readRegularFile, readRegularFileSync, resolveRegularFileAppendFlags, statRegularFile, statRegularFileSync, } from "./regular-file.js";
export { buildRandomTempFilePath, sanitizeTempFileName, tempFile, withTempFile, } from "./temp-target.js";
export { writeSiblingTempFile, writeViaSiblingTempPath, } from "./sibling-temp.js";
export { createIcaclsResetCommand, formatIcaclsResetCommand, formatWindowsAclSummary, inspectWindowsAcl, parseIcaclsOutput, resolveWindowsUserPrincipal, summarizeWindowsAcl, } from "./permissions.js";
