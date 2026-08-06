let fsSafeTestHooks;
function allowFsSafeTestHooks() {
    return process.env.NODE_ENV === "test" || process.env.VITEST === "true";
}
export function getFsSafeTestHooks() {
    return fsSafeTestHooks;
}
export function __setFsSafeTestHooksForTest(hooks) {
    if (hooks && !allowFsSafeTestHooks()) {
        throw new Error("__setFsSafeTestHooksForTest is only available in tests");
    }
    fsSafeTestHooks = hooks;
}
