// Shim: openclaw/plugin-sdk/json-store → vendored fs-safe json helpers.
import { tryReadJsonSync, writeJsonSync } from '../_generated/vendor/fs-safe/dist/json.js';

/** Read small JSON blobs synchronously for token/state caches. */
export function loadJsonFile<T = unknown>(filePath: string): T | undefined {
  return (tryReadJsonSync(filePath) as T | undefined) ?? undefined;
}

/** Persist small JSON blobs synchronously. */
export const saveJsonFile = writeJsonSync;
