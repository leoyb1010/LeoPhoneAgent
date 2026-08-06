export type ExtractionDeadline = {
    signal: AbortSignal;
    check: () => void;
    dispose: () => void;
};
export declare function createPipelineTimeoutError(err: unknown, deadline: ExtractionDeadline): unknown;
export declare function waitForDeadline<T>(promise: Promise<T>, deadline: ExtractionDeadline): Promise<T>;
export declare function withExtractionDeadline<T>(timeoutMs: number, label: string, run: (deadline: ExtractionDeadline) => Promise<T>): Promise<T>;
//# sourceMappingURL=archive-deadline.d.ts.map