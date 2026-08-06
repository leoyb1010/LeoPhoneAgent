export function createAsyncLock() {
    let lock = Promise.resolve();
    return async function withLock(fn) {
        const prev = lock;
        let release;
        lock = new Promise((resolve) => {
            release = resolve;
        });
        await prev;
        try {
            return await fn();
        }
        finally {
            release?.();
        }
    };
}
