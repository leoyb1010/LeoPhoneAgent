export type MovePathWithCopyFallbackOptions = {
    from: string;
    sourceHardlinks?: "allow" | "reject";
    to: string;
};
type MoveCopyFallbackReason = "cross-device" | "windows-rename-denied";
export declare function moveCopyFallbackReasonForRenameError(error: unknown, platform?: NodeJS.Platform): MoveCopyFallbackReason | undefined;
export declare function movePathWithCopyFallback(options: MovePathWithCopyFallbackOptions): Promise<void>;
export {};
//# sourceMappingURL=move-path.d.ts.map