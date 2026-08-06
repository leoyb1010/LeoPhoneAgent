export async function withTimeout(promise, timeoutMs, labelOrOptions = {
    message: "timeout",
}) {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
        return await promise;
    }
    const options = typeof labelOrOptions === "string" ? { label: labelOrOptions } : labelOrOptions;
    const createError = options.createError ??
        (() => new Error(options.message ?? `${options.label ?? "operation"} timed out after ${timeoutMs}ms`));
    let timeoutId;
    try {
        return await Promise.race([
            promise,
            new Promise((_, reject) => {
                timeoutId = setTimeout(() => {
                    try {
                        reject(createError());
                    }
                    catch (error) {
                        reject(error);
                    }
                }, timeoutMs);
            }),
        ]);
    }
    finally {
        if (timeoutId) {
            clearTimeout(timeoutId);
        }
    }
}
