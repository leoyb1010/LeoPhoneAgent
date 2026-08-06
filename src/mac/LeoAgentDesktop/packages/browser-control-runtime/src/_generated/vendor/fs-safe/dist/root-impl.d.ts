import type { Stats } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { type DenyMutationPolicy } from "./deny-mutations.js";
import { type ReadResult } from "./read-opened-file.js";
import type { DirEntry, PathStat } from "./types.js";
export type { DenyMutationPolicy } from "./deny-mutations.js";
export { resolveOpenedFileRealPathForHandle } from "./opened-realpath.js";
export type { ReadResult } from "./read-opened-file.js";
export type OpenResult = {
    handle: FileHandle;
    realPath: string;
    stat: Stats;
    [Symbol.asyncDispose](): Promise<void>;
};
export type RootOptions = {
    rootDir: string;
    defaults?: RootDefaults;
};
export type SymlinkPolicy = "reject" | "follow-within-root";
export type HardlinkPolicy = "reject" | "allow";
export type WritableOpenMode = "replace" | "append" | "update";
export type RootDefaults = {
    hardlinks?: HardlinkPolicy;
    maxBytes?: number;
    mkdir?: boolean;
    mode?: number;
    denyMutations?: DenyMutationPolicy;
    nonBlockingRead?: boolean;
    symlinks?: SymlinkPolicy;
};
export type RootReadOptions = Pick<RootDefaults, "hardlinks" | "maxBytes" | "nonBlockingRead" | "symlinks">;
export type RootOpenOptions = Omit<RootReadOptions, "maxBytes">;
export type RootWriteOptions = Pick<RootDefaults, "denyMutations" | "mkdir" | "mode"> & {
    encoding?: BufferEncoding;
    overwrite?: boolean;
};
export type RootOpenWritableOptions = Pick<RootDefaults, "denyMutations" | "mkdir" | "mode"> & {
    writeMode?: WritableOpenMode;
};
export type RootCopyOptions = Pick<RootDefaults, "denyMutations" | "maxBytes" | "mkdir" | "mode"> & {
    sourceHardlinks?: HardlinkPolicy;
};
export type RootWriteJsonOptions = RootWriteOptions & {
    replacer?: Parameters<typeof JSON.stringify>[1];
    space?: Parameters<typeof JSON.stringify>[2];
    trailingNewline?: boolean;
};
export type RootCreateOptions = Omit<RootWriteOptions, "overwrite">;
export type RootCreateJsonOptions = Omit<RootWriteJsonOptions, "overwrite">;
export type RootAppendOptions = RootWriteOptions & {
    prependNewlineIfNeeded?: boolean;
};
export type RootMoveOptions = Pick<RootDefaults, "denyMutations"> & {
    overwrite?: boolean;
};
export type RootRemoveOptions = Pick<RootDefaults, "denyMutations">;
export type RootMkdirOptions = Pick<RootDefaults, "denyMutations">;
export declare const DEFAULT_ROOT_MAX_BYTES: number;
export interface Root {
    readonly rootDir: string;
    readonly rootReal: string;
    readonly rootWithSep: string;
    readonly defaults: RootDefaults;
    resolve(relativePath: string): Promise<string>;
    open(relativePath: string, options?: RootOpenOptions): Promise<OpenResult>;
    read(relativePath: string, options?: RootReadOptions): Promise<ReadResult>;
    readBytes(relativePath: string, options?: RootReadOptions): Promise<Buffer>;
    readText(relativePath: string, options?: RootReadOptions & {
        encoding?: BufferEncoding;
    }): Promise<string>;
    readJson<T = unknown>(relativePath: string, options?: RootReadOptions & {
        encoding?: BufferEncoding;
    }): Promise<T>;
    readAbsolute(filePath: string, options?: RootReadOptions): Promise<ReadResult>;
    reader(options?: RootReadOptions): (filePath: string) => Promise<Buffer>;
    openWritable(relativePath: string, options?: RootOpenWritableOptions): Promise<WritableOpenResult>;
    append(relativePath: string, data: string | Buffer, options?: RootAppendOptions): Promise<void>;
    remove(relativePath: string, options?: RootRemoveOptions): Promise<void>;
    mkdir(relativePath: string, options?: RootMkdirOptions): Promise<void>;
    ensureRoot(options?: RootMkdirOptions): Promise<void>;
    write(relativePath: string, data: string | Buffer, options?: RootWriteOptions): Promise<void>;
    create(relativePath: string, data: string | Buffer, options?: RootCreateOptions): Promise<void>;
    writeJson(relativePath: string, data: unknown, options?: RootWriteJsonOptions): Promise<void>;
    createJson(relativePath: string, data: unknown, options?: RootCreateJsonOptions): Promise<void>;
    copyIn(relativePath: string, sourcePath: string, options?: RootCopyOptions): Promise<void>;
    exists(relativePath: string): Promise<boolean>;
    stat(relativePath: string): Promise<PathStat>;
    list(relativePath: string, options?: {
        withFileTypes?: false;
    }): Promise<string[]>;
    list(relativePath: string, options: {
        withFileTypes: true;
    }): Promise<DirEntry[]>;
    move(fromRelative: string, toRelative: string, options?: RootMoveOptions): Promise<void>;
}
export declare function root(rootDir: string, defaults?: RootDefaults): Promise<Root>;
export declare function readLocalFileSafely(params: {
    filePath: string;
    maxBytes?: number;
}): Promise<ReadResult>;
export declare function openLocalFileSafely(params: {
    filePath: string;
}): Promise<OpenResult>;
export type WritableOpenResult = {
    handle: FileHandle;
    createdForWrite: boolean;
    realPath: string;
    stat: Stats;
    [Symbol.asyncDispose](): Promise<void>;
};
//# sourceMappingURL=root-impl.d.ts.map