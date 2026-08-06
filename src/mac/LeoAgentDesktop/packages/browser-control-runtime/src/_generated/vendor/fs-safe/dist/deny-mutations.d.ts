export type DenyMutationPolicy = {
    paths?: readonly string[];
    prefixes?: readonly string[];
};
type DenyMutationCheckOptions = {
    protectAncestors?: boolean;
};
export declare function assertMutationNotDenied(filePath: string, policy: DenyMutationPolicy | undefined, options?: DenyMutationCheckOptions): Promise<void>;
export declare function mergeDenyMutationPolicies(defaultPolicy: DenyMutationPolicy | undefined, callPolicy: DenyMutationPolicy | undefined): DenyMutationPolicy | undefined;
export {};
//# sourceMappingURL=deny-mutations.d.ts.map