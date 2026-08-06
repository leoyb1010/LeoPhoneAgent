/**
 * Branch base ref validation shared by main and renderer.
 *
 * Main (git-review/branchReader) uses it as the IPC trust-boundary gate before
 * any git invocation; renderer (review plugin hydrate) uses the same rule to
 * drop unsafe persisted values early. Keeping one copy prevents the two sides
 * from drifting apart. This is a conservative pre-filter — main still runs
 * `git check-ref-format --branch` behind it.
 */
export function isSafeBranchBaseRef(baseRef: string): boolean {
  if (!baseRef || baseRef.length > 300 || baseRef.startsWith('-')) return false;
  if (/[\0-\x20\x7f]/.test(baseRef)) return false;
  if (baseRef === 'HEAD' || baseRef === '@') return false;
  if (baseRef.includes('\\') || baseRef.includes('..') || baseRef.includes('@{')) return false;
  if (/[~^:?*]/.test(baseRef) || baseRef.includes('[')) return false;
  if (baseRef.includes('//') || baseRef.endsWith('/') || baseRef.endsWith('.')) return false;
  return true;
}
