export declare function mkdirPathComponentsWithGuards(params: {
    rootReal: string;
    targetPath: string;
    beforeComponent?: (componentPath: string) => Promise<void> | void;
}): Promise<void>;
//# sourceMappingURL=guarded-mkdir.d.ts.map