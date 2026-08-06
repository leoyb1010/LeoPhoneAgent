/**
 * projectHash — deterministic short id for a normalized project path.
 *
 * Both the renderer (which derives the project list from CC Agent sessions
 * via `normalizeWorkingDir`) and the URL router (which decodes `:projectHash`)
 * compute the same value for the same input. We pass these hashes alongside
 * paths to the main-process skill scanner, which copies them onto each
 * resulting Skill — that way the URL slug never has to encode a full
 * filesystem path (which contains characters incompatible with React Router
 * segments) and main never has to know which hash function we use.
 *
 * FNV-1a 32-bit was picked over crypto.subtle.digest for two reasons:
 *   1. It's synchronous — call it inline during render without juggling
 *      promises every time we need a URL slug.
 *   2. It's tiny, dependency-free, and works identically in main + renderer
 *      without sharing a module.
 *
 * 8-hex-char output gives ~4B distinct slugs — well past the realistic
 * project count for any single user — and stays human-glanceable in URLs.
 */

export function projectHash(normalizedPath: string): string {
  let h = 2166136261; // FNV-1a 32-bit offset basis
  for (let i = 0; i < normalizedPath.length; i++) {
    h ^= normalizedPath.charCodeAt(i);
    h = Math.imul(h, 16777619); // FNV prime
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}
