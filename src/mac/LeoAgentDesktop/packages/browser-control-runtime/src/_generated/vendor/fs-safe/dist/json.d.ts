import fsSync from "node:fs";
import { type RootFileOpenFailure } from "./root-file.js";
import { type WriteTextAtomicOptions } from "./text-atomic.js";
export declare function tryReadJsonSync<T = unknown>(pathname: string): T | null;
export declare function writeJsonSync(pathname: string, data: unknown): void;
export declare class JsonFileReadError extends Error {
    readonly filePath: string;
    readonly reason: "read" | "parse";
    constructor(filePath: string, reason: "read" | "parse", cause: unknown);
}
export type RootStructuredFileReadResult<T> = {
    ok: true;
    value: T;
    stat: fsSync.Stats;
    path: string;
    rootRealPath: string;
} | {
    ok: false;
    reason: "open";
    failure: RootFileOpenFailure;
} | {
    ok: false;
    reason: "invalid" | "parse";
    error: string;
};
export type ReadRootStructuredFileSyncOptions<T> = {
    rootDir: string;
    rootRealPath?: string;
    relativePath: string;
    boundaryLabel: string;
    rejectHardlinks?: boolean;
    maxBytes?: number;
    parse: (raw: string) => unknown;
    validate?: (value: unknown) => value is T;
    invalidMessage?: string | ((relativePath: string) => string);
};
export type ReadRootJsonSyncOptions = Omit<ReadRootStructuredFileSyncOptions<unknown>, "parse" | "validate" | "invalidMessage">;
export declare function readRootStructuredFileSync<T>(options: ReadRootStructuredFileSyncOptions<T>): RootStructuredFileReadResult<T>;
export declare function readRootJsonSync<T = unknown>(options: ReadRootJsonSyncOptions): RootStructuredFileReadResult<T>;
export declare function readRootJsonObjectSync(options: ReadRootJsonSyncOptions): RootStructuredFileReadResult<Record<string, unknown>>;
export declare function tryReadJson<T>(filePath: string): Promise<T | null>;
export declare function readJson<T>(filePath: string): Promise<T>;
export declare function readJsonIfExists<T>(filePath: string): Promise<T | null>;
export declare function readJsonSync<T = unknown>(filePath: string): T;
export type WriteJsonOptions = Pick<WriteTextAtomicOptions, "dirMode" | "durable" | "mode" | "trailingNewline">;
export declare function writeJson(filePath: string, value: unknown, options?: WriteJsonOptions): Promise<void>;
//# sourceMappingURL=json.d.ts.map