export type FsSafePythonMode = "auto" | "off" | "require";
export type FsSafePythonConfig = {
    mode: FsSafePythonMode;
    pythonPath?: string;
};
export declare function configureFsSafePython(config: Partial<FsSafePythonConfig>): void;
export declare function getFsSafePythonConfig(): FsSafePythonConfig;
export declare function canFallbackFromPythonError(error: unknown): boolean;
//# sourceMappingURL=pinned-python-config.d.ts.map