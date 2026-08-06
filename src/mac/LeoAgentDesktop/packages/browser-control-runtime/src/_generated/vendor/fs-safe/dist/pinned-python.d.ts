type PinnedPythonOperation = "copy" | "stat" | "readdir" | "mkdirp" | "remove" | "rename" | "write";
export declare function __resetPinnedPythonWorkerForTest(): void;
export declare function runPinnedPythonOperation<T>(params: {
    operation: PinnedPythonOperation;
    rootPath: string;
    payload: Record<string, unknown>;
}): Promise<T>;
export declare function assertPinnedPythonOperationAvailable(): void;
export declare function validatePinnedOperationPayload(payload: Record<string, unknown>): void;
export declare function isPinnedHelperUnavailable(error: unknown): boolean;
export {};
//# sourceMappingURL=pinned-python.d.ts.map