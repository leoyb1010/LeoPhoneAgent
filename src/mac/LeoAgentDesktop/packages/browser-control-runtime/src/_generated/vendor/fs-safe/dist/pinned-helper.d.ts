import type { DirEntry, PathStat } from "./types.js";
import { isPinnedHelperUnavailable } from "./pinned-python.js";
type HelperOperation = "stat" | "readdir" | "mkdirp" | "remove" | "rename";
export { isPinnedHelperUnavailable };
export declare function runPinnedHelper<T>(operation: HelperOperation, rootDir: string, payload: Record<string, unknown>): Promise<T>;
export declare function helperStat(rootDir: string, relativePath: string): Promise<PathStat>;
export declare function helperReaddir(rootDir: string, relativePath: string, withFileTypes: false): Promise<string[]>;
export declare function helperReaddir(rootDir: string, relativePath: string, withFileTypes: true): Promise<DirEntry[]>;
//# sourceMappingURL=pinned-helper.d.ts.map