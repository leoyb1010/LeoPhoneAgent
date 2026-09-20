/** 写完/改完后目录要跟上，不然新文件只活在流水里。 */

const TREE_TOOLS = new Set(['write', 'edit']);

export function sessionTreeNeedsRefresh(event?: {
  event?: unknown;
  tool?: unknown;
  error?: unknown;
} | null): boolean {
  if (!event || String(event.event ?? '') !== 'tool.completed') return false;
  if (event.error) return false;
  return TREE_TOOLS.has(String(event.tool ?? ''));
}
