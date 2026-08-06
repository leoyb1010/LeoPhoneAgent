import os from "node:os";
import path from "node:path";
import { normalizeOptionalString } from "./string-coerce.js";
function normalize(value) {
    const trimmed = normalizeOptionalString(value);
    if (!trimmed) {
        return undefined;
    }
    if (trimmed === "undefined" || trimmed === "null") {
        return undefined;
    }
    return trimmed;
}
export function resolveEffectiveHomeDir(env = process.env, homedir = os.homedir) {
    const raw = resolveRawHomeDir(env, homedir);
    return raw ? path.resolve(raw) : undefined;
}
export function resolveOsHomeDir(env = process.env, homedir = os.homedir) {
    const raw = resolveRawOsHomeDir(env, homedir);
    return raw ? path.resolve(raw) : undefined;
}
function resolveRawHomeDir(env, homedir) {
    const explicitHome = normalize(env.OPENCLAW_HOME);
    if (!explicitHome) {
        return resolveRawOsHomeDir(env, homedir);
    }
    const segments = path.normalize(explicitHome).split(path.sep);
    if (segments[0] !== "~") {
        return explicitHome;
    }
    // OPENCLAW_HOME starts with "~"; expand against the os home dir. Fall
    // back to undefined when there is no os home to expand against rather
    // than returning a raw "~"-prefixed path the caller cannot use.
    const fallbackHome = resolveRawOsHomeDir(env, homedir);
    if (!fallbackHome) {
        return undefined;
    }
    return expandHomePrefix(explicitHome, { home: fallbackHome });
}
function resolveRawOsHomeDir(env, homedir) {
    const envHome = normalize(env.HOME);
    if (envHome) {
        return envHome;
    }
    const userProfile = normalize(env.USERPROFILE);
    if (userProfile) {
        return userProfile;
    }
    return normalizeSafe(homedir);
}
function normalizeSafe(homedir) {
    try {
        return normalize(homedir());
    }
    catch {
        return undefined;
    }
}
export function resolveRequiredHomeDir(env = process.env, homedir = os.homedir) {
    return resolveEffectiveHomeDir(env, homedir) ?? path.resolve(process.cwd());
}
export function resolveRequiredOsHomeDir(env = process.env, homedir = os.homedir) {
    return resolveOsHomeDir(env, homedir) ?? path.resolve(process.cwd());
}
export function expandHomePrefix(input, opts) {
    const segments = path.normalize(input).split(path.sep);
    if (segments[0] !== "~") {
        return input;
    }
    const home = normalize(opts?.home) ??
        resolveEffectiveHomeDir(opts?.env ?? process.env, opts?.homedir ?? os.homedir);
    if (!home) {
        return input;
    }
    return path.join(home, ...segments.slice(1));
}
export function resolveHomeRelativePath(input, opts) {
    if (!input) {
        return input;
    }
    const segments = path.normalize(input).split(path.sep);
    if (segments[0] !== "~") {
        return path.resolve(input);
    }
    const expanded = expandHomePrefix(input, {
        home: resolveRequiredHomeDir(opts?.env ?? process.env, opts?.homedir ?? os.homedir),
        env: opts?.env,
        homedir: opts?.homedir,
    });
    return path.resolve(expanded);
}
export function resolveUserPath(input, optsOrEnv, homedir) {
    const opts = optsOrEnv && ("env" in optsOrEnv || "homedir" in optsOrEnv)
        ? optsOrEnv
        : { env: optsOrEnv, homedir };
    return resolveHomeRelativePath(input, opts);
}
export function resolveOsHomeRelativePath(input, opts) {
    if (!input) {
        return input;
    }
    const segments = path.normalize(input).split(path.sep);
    if (segments[0] !== "~") {
        return path.resolve(input);
    }
    const expanded = expandHomePrefix(input, {
        home: resolveRequiredOsHomeDir(opts?.env ?? process.env, opts?.homedir ?? os.homedir),
        env: opts?.env,
        homedir: opts?.homedir,
    });
    return path.resolve(expanded);
}
