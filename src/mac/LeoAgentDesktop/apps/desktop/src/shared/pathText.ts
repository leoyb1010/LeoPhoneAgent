/**
 * Path-string helpers shared between the main and renderer processes.
 *
 * Lives in `src/shared` (like `textFileExts.ts`) so both processes import the same
 * canonical implementation via relative paths.
 */

/**
 * Strip trailing path separators (`/` and `\`) from a string.
 *
 * Behaviour-identical to `value.replace(/[\\/]+$/, '')` but linear (O(n)): it walks
 * back from the end instead of letting the regex engine retry the anchored `[\\/]+$`
 * at every offset, which CodeQL flags as a degree-2 polynomial ReDoS on long runs of
 * separators (`js/polynomial-redos`).
 */
export function stripTrailingPathSeparators(value: string): string {
  let end = value.length;
  while (end > 0 && (value[end - 1] === '/' || value[end - 1] === '\\')) {
    end -= 1;
  }
  return end === value.length ? value : value.slice(0, end);
}
