function signalReason(signal, fallback) {
    const reason = signal.reason;
    return reason instanceof Error ? reason : fallback ?? new Error(String(reason));
}
function deadlineReason(deadline) {
    return signalReason(deadline.signal);
}
export function createPipelineTimeoutError(err, deadline) {
    if (deadline.signal.aborted &&
        err instanceof Error &&
        (err.name === "AbortError" || err.message === "The operation was aborted")) {
        return deadlineReason(deadline);
    }
    return err;
}
export async function waitForDeadline(promise, deadline) {
    deadline.check();
    if (deadline.signal.aborted) {
        throw deadlineReason(deadline);
    }
    return await Promise.race([
        promise,
        new Promise((_, reject) => {
            const abort = () => reject(deadlineReason(deadline));
            deadline.signal.addEventListener("abort", abort, { once: true });
            const cleanup = () => {
                deadline.signal.removeEventListener("abort", abort);
            };
            promise.then(cleanup, cleanup);
        }),
    ]);
}
function createExtractionDeadline(timeoutMs, label) {
    const controller = new AbortController();
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
        return {
            signal: controller.signal,
            check: () => undefined,
            dispose: () => undefined,
        };
    }
    const timeoutError = new Error(`${label} timed out after ${timeoutMs}ms`);
    const timeoutId = setTimeout(() => {
        controller.abort(timeoutError);
    }, timeoutMs);
    return {
        signal: controller.signal,
        check: () => {
            if (controller.signal.aborted) {
                throw signalReason(controller.signal, timeoutError);
            }
        },
        dispose: () => {
            clearTimeout(timeoutId);
        },
    };
}
export async function withExtractionDeadline(timeoutMs, label, run) {
    const deadline = createExtractionDeadline(timeoutMs, label);
    try {
        deadline.check();
        return await waitForDeadline(run(deadline), deadline);
    }
    finally {
        deadline.dispose();
    }
}
