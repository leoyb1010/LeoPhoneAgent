/**
 * Build URL search params for a normal file selection in doc mode.
 *
 * Project-search jumps use `search` and `line` as one-shot navigation anchors.
 * Plain file selection from the tree or open-file tabs must clear them, or the
 * next document mount can scroll to a stale search result instead of restoring
 * that file's own reading position.
 */
export function buildNormalFileSelectionParams(
  prev: URLSearchParams,
  relPath: string,
): URLSearchParams {
  const next = new URLSearchParams(prev);
  next.set('file', relPath);
  next.delete('search');
  next.delete('line');
  return next;
}

export function clearConsumedSearchJumpParams(prev: URLSearchParams): URLSearchParams {
  const next = new URLSearchParams(prev);
  next.delete('search');
  next.delete('line');
  return next;
}

export function shouldConsumeStaleSearchJump(
  run: { query: string; total: number } | null,
  jumpQuery: string,
): boolean {
  return run?.query === jumpQuery && run.total === 0;
}
