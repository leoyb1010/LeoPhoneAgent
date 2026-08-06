const writeQueues = new Map();
export async function serializePathWrite(key, run) {
    const previous = writeQueues.get(key) ?? Promise.resolve();
    const task = (async () => {
        await previous.catch(() => undefined);
        return await run();
    })();
    const done = task.then(() => undefined, () => undefined);
    writeQueues.set(key, done);
    try {
        return await task;
    }
    finally {
        if (writeQueues.get(key) === done) {
            writeQueues.delete(key);
        }
    }
}
