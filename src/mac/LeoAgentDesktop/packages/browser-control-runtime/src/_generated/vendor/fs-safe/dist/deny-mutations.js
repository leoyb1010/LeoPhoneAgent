import fs from "node:fs/promises";
import path from "node:path";
import { FsSafeError } from "./errors.js";
import { assertNoNulPathInput, isNotFoundPathError, isPathInside } from "./path.js";
async function pathExists(filePath) {
    try {
        await fs.lstat(filePath);
        return true;
    }
    catch (err) {
        if (!isNotFoundPathError(err)) {
            throw err;
        }
        return false;
    }
}
async function resolvePathViaExistingAncestor(targetPath) {
    const normalized = path.resolve(targetPath);
    let cursor = normalized;
    const missingSuffix = [];
    while (path.dirname(cursor) !== cursor && !(await pathExists(cursor))) {
        missingSuffix.unshift(path.basename(cursor));
        cursor = path.dirname(cursor);
    }
    if (!(await pathExists(cursor))) {
        return normalized;
    }
    try {
        const resolvedAncestor = path.resolve(await fs.realpath(cursor));
        return missingSuffix.length === 0
            ? resolvedAncestor
            : path.resolve(resolvedAncestor, ...missingSuffix);
    }
    catch {
        return normalized;
    }
}
async function comparablePaths(rawPath) {
    assertNoNulPathInput(rawPath, "path contains a NUL byte");
    const resolved = path.resolve(rawPath);
    return new Set([resolved, await resolvePathViaExistingAncestor(resolved)]);
}
function isSamePath(left, right) {
    return isPathInside(left, right) && isPathInside(right, left);
}
function hasPolicyEntries(policy) {
    return Boolean(policy?.paths?.length || policy?.prefixes?.length);
}
function policyPathEntries(entries) {
    const paths = [];
    for (const entry of entries ?? []) {
        if (entry.length === 0) {
            throw new FsSafeError("invalid-path", "deny mutation paths must be non-empty");
        }
        assertNoNulPathInput(entry, "deny mutation path contains a NUL byte");
        if (!path.isAbsolute(entry)) {
            throw new FsSafeError("invalid-path", "deny mutation paths must be absolute");
        }
        paths.push(entry);
    }
    return paths;
}
export async function assertMutationNotDenied(filePath, policy, options = {}) {
    if (!hasPolicyEntries(policy)) {
        return;
    }
    const targetPaths = await comparablePaths(filePath);
    for (const deniedPath of policyPathEntries(policy.paths)) {
        const deniedPaths = await comparablePaths(deniedPath);
        for (const target of targetPaths) {
            for (const denied of deniedPaths) {
                if (isSamePath(denied, target) ||
                    (options.protectAncestors === true && isPathInside(target, denied))) {
                    throw new FsSafeError("denied-path", "path is denied by denyMutations policy");
                }
            }
        }
    }
    for (const deniedPrefix of policyPathEntries(policy.prefixes)) {
        const deniedPaths = await comparablePaths(deniedPrefix);
        for (const target of targetPaths) {
            for (const denied of deniedPaths) {
                if (isPathInside(denied, target) ||
                    (options.protectAncestors === true && isPathInside(target, denied))) {
                    throw new FsSafeError("denied-path", "path is denied by denyMutations policy");
                }
            }
        }
    }
}
export function mergeDenyMutationPolicies(defaultPolicy, callPolicy) {
    if (!defaultPolicy) {
        return callPolicy;
    }
    if (!callPolicy) {
        return defaultPolicy;
    }
    return {
        paths: [...(defaultPolicy.paths ?? []), ...(callPolicy.paths ?? [])],
        prefixes: [...(defaultPolicy.prefixes ?? []), ...(callPolicy.prefixes ?? [])],
    };
}
