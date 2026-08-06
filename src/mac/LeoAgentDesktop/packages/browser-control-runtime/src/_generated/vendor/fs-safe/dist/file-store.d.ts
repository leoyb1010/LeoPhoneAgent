import type { Readable } from "node:stream";
import { type FileStorePruneOptions } from "./file-store-prune.js";
export type { FileStorePruneOptions } from "./file-store-prune.js";
import { type JsonFileStoreOptions, type JsonStore } from "./json-document-store.js";
import { type OpenResult, type ReadResult, type Root, type RootReadOptions } from "./root.js";
export type FileStoreOptions = {
    rootDir: string;
    private?: boolean;
    dirMode?: number;
    mode?: number;
    maxBytes?: number;
};
export type FileStoreWriteOptions = {
    dirMode?: number;
    mode?: number;
    maxBytes?: number;
    tempPrefix?: string;
};
export type FileStoreReadOptions = RootReadOptions & {
    encoding?: BufferEncoding;
};
export type FileStore = {
    readonly rootDir: string;
    path(relativePath: string): string;
    root(): Promise<Root>;
    write(relativePath: string, data: string | Uint8Array, options?: FileStoreWriteOptions): Promise<string>;
    writeStream(relativePath: string, stream: Readable, options?: FileStoreWriteOptions): Promise<string>;
    copyIn(relativePath: string, sourcePath: string, options?: FileStoreWriteOptions): Promise<string>;
    open(relativePath: string, options?: RootReadOptions): Promise<OpenResult>;
    read(relativePath: string, options?: RootReadOptions): Promise<ReadResult>;
    readBytes(relativePath: string, options?: RootReadOptions): Promise<Buffer>;
    readText(relativePath: string, options?: FileStoreReadOptions): Promise<string>;
    readTextIfExists(relativePath: string, options?: FileStoreReadOptions): Promise<string | null>;
    readJson<T = unknown>(relativePath: string, options?: FileStoreReadOptions): Promise<T>;
    readJsonIfExists<T = unknown>(relativePath: string, options?: FileStoreReadOptions): Promise<T | null>;
    remove(relativePath: string): Promise<void>;
    exists(relativePath: string): Promise<boolean>;
    writeText(relativePath: string, data: string | Uint8Array, options?: FileStoreWriteOptions): Promise<string>;
    writeJson(relativePath: string, data: unknown, options?: FileStoreWriteOptions & {
        trailingNewline?: boolean;
    }): Promise<string>;
    json<T = unknown>(relativePath: string, options?: JsonFileStoreOptions): JsonStore<T>;
    pruneExpired(options: FileStorePruneOptions): Promise<void>;
};
export type FileStoreSync = {
    readonly rootDir: string;
    path(relativePath: string): string;
    readTextIfExists(relativePath: string, options?: {
        maxBytes?: number;
    }): string | null;
    readJsonIfExists<T = unknown>(relativePath: string, options?: {
        maxBytes?: number;
    }): T | null;
    write(relativePath: string, data: string | Uint8Array, options?: FileStoreWriteOptions): string;
    writeText(relativePath: string, data: string | Uint8Array, options?: FileStoreWriteOptions): string;
    writeJson(relativePath: string, data: unknown, options?: FileStoreWriteOptions & {
        trailingNewline?: boolean;
    }): string;
};
export declare function fileStore(options: FileStoreOptions): FileStore;
export declare function fileStoreSync(options: FileStoreOptions): FileStoreSync;
//# sourceMappingURL=file-store.d.ts.map