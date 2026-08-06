import path from "node:path";
import { fileStore } from "./file-store.js";
import { createJsonStore, } from "./json-document-store.js";
export function jsonStore(options) {
    const filePath = path.resolve(options.filePath);
    return fileStore({
        rootDir: path.dirname(filePath),
        private: true,
        mode: options.mode,
        dirMode: options.dirMode,
    }).json(path.basename(filePath), options);
}
