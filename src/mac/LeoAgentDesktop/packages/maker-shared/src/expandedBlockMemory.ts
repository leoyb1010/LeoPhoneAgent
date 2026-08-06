/**
 * expandedBlockMemory
 * ---------------------------------------------------------------------------
 * Framework-agnostic in-memory store for per-block expand/collapse state in
 * the chat message stream (thinking cards, tool groups, agent task cards,
 * work groups, subagent cards). Shared by the desktop and mobile clients so
 * both ends keep the same semantics:
 *
 *   - Default state for every block id is **collapsed**.
 *   - Manual expansions are remembered for the lifetime of the app process —
 *     they survive session switches and list-virtualization remounts, but are
 *     intentionally NOT persisted across restarts (persistence made tool
 *     blocks greet the user pre-opened, which felt noisy).
 *   - Bounded: oldest entries are evicted beyond `maxEntries`.
 *
 * Each client creates its own module-level store instance and wraps it in a
 * thin React hook (desktop: `useExpandedBlockMemory`, mobile:
 * `useFoldableExpandedState`). Block ids must be stable across re-grouping —
 * render-item keys derived from message clientIds satisfy this.
 */

export interface ExpandedBlockStoreOptions {
  /** Max remembered expanded blocks; the oldest entry is evicted beyond this. Default 500. */
  maxEntries?: number;
  /** Called when a subscriber callback throws (clients wire their logger here). */
  onSubscriberError?: (error: unknown) => void;
}

export interface ExpandedBlockStore {
  /** Whether the block is currently expanded. Default: false (collapsed). */
  isExpanded(blockId: string): boolean;
  /** Set a block's expanded state; notifies subscribers on change. */
  setExpanded(blockId: string, expanded: boolean): void;
  /** Subscribe to any state change; returns an unsubscribe function. */
  subscribe(listener: () => void): () => void;
  /** Clear all entries and subscribers (tests only). */
  reset(): void;
}

export function createExpandedBlockStore(
  options: ExpandedBlockStoreOptions = {},
): ExpandedBlockStore {
  const maxEntries = options.maxEntries ?? 500;
  const expanded = new Set<string>();
  const subscribers = new Set<() => void>();

  const notify = (): void => {
    for (const listener of subscribers) {
      try {
        listener();
      } catch (error) {
        options.onSubscriberError?.(error);
      }
    }
  };

  return {
    isExpanded(blockId) {
      return expanded.has(blockId);
    },
    setExpanded(blockId, next) {
      const prev = expanded.has(blockId);
      if (next === prev) return;
      if (next) {
        expanded.add(blockId);
        if (expanded.size > maxEntries) {
          const oldest = expanded.values().next().value;
          if (oldest !== undefined) expanded.delete(oldest);
        }
      } else {
        expanded.delete(blockId);
      }
      notify();
    },
    subscribe(listener) {
      subscribers.add(listener);
      return () => {
        subscribers.delete(listener);
      };
    },
    reset() {
      expanded.clear();
      subscribers.clear();
    },
  };
}
