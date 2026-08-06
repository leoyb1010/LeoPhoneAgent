import fs from "node:fs/promises";
import os from "node:os";
import { ROOT_PATH_ALIAS_POLICIES, resolveRootPath, } from "./root-path.js";
import { isNotFoundPathError } from "./path.js";
export const PATH_ALIAS_POLICIES = ROOT_PATH_ALIAS_POLICIES;
export async function assertNoPathAliasEscape(params) {
    const resolved = await resolveRootPath({
        absolutePath: params.absolutePath,
        rootPath: params.rootPath,
        boundaryLabel: params.boundaryLabel,
        policy: params.policy,
    });
    const allowFinalSymlink = params.policy?.allowFinalSymlinkForUnlink === true;
    if (allowFinalSymlink && resolved.kind === "symlink") {
        return;
    }
    await assertNoHardlinkedFinalPath({
        filePath: resolved.absolutePath,
        root: resolved.rootPath,
        boundaryLabel: params.boundaryLabel,
        allowFinalHardlinkForUnlink: params.policy?.allowFinalHardlinkForUnlink,
    });
}
export async function assertNoHardlinkedFinalPath(params) {
    if (params.allowFinalHardlinkForUnlink) {
        return;
    }
    let stat;
    try {
        stat = await fs.stat(params.filePath);
    }
    catch (err) {
        if (isNotFoundPathError(err)) {
            return;
        }
        throw err;
    }
    if (!stat.isFile()) {
        return;
    }
    if (stat.nlink > 1) {
        throw new Error(`Hardlinked path is not allowed under ${params.boundaryLabel} (${shortPath(params.root)}): ${shortPath(params.filePath)}`);
    }
}
function shortPath(value) {
    if (value.startsWith(os.homedir())) {
        return `~${value.slice(os.homedir().length)}`;
    }
    return value;
}
