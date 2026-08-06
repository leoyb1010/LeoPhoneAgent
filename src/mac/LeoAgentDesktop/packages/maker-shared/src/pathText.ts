/**
 * Strip trailing path separators ('/' or '\\') from a string.
 *
 * Behaves exactly like `value.replace(/[\\/]+$/, '')` but in linear time. The regex form is a
 * trailing-repetition-with-anchor, which backtracks polynomially on uncontrolled path input
 * (CodeQL: "Polynomial regular expression used on uncontrolled data"). Path basenames run on
 * remote/user-supplied paths, so we scan from the end instead.
 */
export function stripTrailingPathSeparators(value: string): string {
  let end = value.length;
  while (end > 0) {
    const code = value.charCodeAt(end - 1);
    if (code !== 47 /* / */ && code !== 92 /* \ */) break;
    end -= 1;
  }
  return end === value.length ? value : value.slice(0, end);
}
