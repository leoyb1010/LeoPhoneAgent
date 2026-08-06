let overrideConfig = {};
function parseMode(value) {
    if (!value) {
        return undefined;
    }
    const normalized = value.trim().toLowerCase();
    if (normalized === "0" || normalized === "false" || normalized === "off" || normalized === "never") {
        return "off";
    }
    if (normalized === "1" || normalized === "true" || normalized === "on" || normalized === "auto") {
        return "auto";
    }
    if (normalized === "required" || normalized === "require") {
        return "require";
    }
    return undefined;
}
export function configureFsSafePython(config) {
    overrideConfig = { ...overrideConfig, ...config };
}
export function getFsSafePythonConfig() {
    return {
        mode: overrideConfig.mode ??
            parseMode(process.env.FS_SAFE_PYTHON_MODE) ??
            parseMode(process.env.OPENCLAW_FS_SAFE_PYTHON_MODE) ??
            "auto",
        pythonPath: overrideConfig.pythonPath ??
            process.env.FS_SAFE_PYTHON ??
            process.env.OPENCLAW_FS_SAFE_PYTHON ??
            process.env.OPENCLAW_PINNED_PYTHON ??
            process.env.OPENCLAW_PINNED_WRITE_PYTHON,
    };
}
export function canFallbackFromPythonError(error) {
    const code = error instanceof Error && "code" in error ? error.code : undefined;
    return (getFsSafePythonConfig().mode !== "require" &&
        (code === "helper-unavailable" || code === "unsupported-platform"));
}
