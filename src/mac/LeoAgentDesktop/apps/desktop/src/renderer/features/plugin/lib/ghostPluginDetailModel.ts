/**
 * Pure description helpers for the Plugin detail page.
 *
 * Permission presentation intentionally consumes the shared Ghost permission items directly.
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */

/** Returns the complete normalized description without model-generated copy. */
export function ghostPluginSummary(description: string, fallback: string): string {
  const normalized = description.replace(/\s+/g, ' ').trim();
  return normalized || fallback;
}
