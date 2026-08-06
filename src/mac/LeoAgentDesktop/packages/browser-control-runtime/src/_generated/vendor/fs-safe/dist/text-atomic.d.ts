export type WriteTextAtomicOptions = {
    mode?: number;
    dirMode?: number;
    trailingNewline?: boolean;
    /**
     * When false, skip the temp-file and parent-directory fsync calls while
     * preserving the temp-file replace/rename behavior.
     *
     * Defaults to true.
     */
    durable?: boolean;
};
export declare function writeTextAtomic(filePath: string, content: string, options?: WriteTextAtomicOptions): Promise<void>;
//# sourceMappingURL=text-atomic.d.ts.map