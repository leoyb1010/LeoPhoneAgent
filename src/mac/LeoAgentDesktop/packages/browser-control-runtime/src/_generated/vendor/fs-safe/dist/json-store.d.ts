import { type JsonFileStoreOptions, type JsonStore, type JsonStoreLockOptions } from "./json-document-store.js";
export type JsonStoreOptions<T> = JsonFileStoreOptions & {
    filePath: string;
    dirMode?: number;
    mode?: number;
};
export type { JsonFileStoreOptions, JsonStore, JsonStoreLockOptions };
export declare function jsonStore<T>(options: JsonStoreOptions<T>): JsonStore<T>;
//# sourceMappingURL=json-store.d.ts.map