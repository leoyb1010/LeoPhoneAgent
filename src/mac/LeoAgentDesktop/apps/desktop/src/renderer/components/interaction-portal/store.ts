/**
 * Interaction Prompt Portal — module-level slot registry.
 *
 * Use case: in some layouts (workdir-browse doc mode) the chat session view
 * is squeezed into a narrow rail (~420 px) where Permission / AskUser / Plan
 * cards visually break. Rather than letting them render in the rail, hosts
 * can register a "preferred slot" elsewhere on screen and the host renders a
 * waiting placeholder in the rail instead. The Host component (next door)
 * looks up this slot and createPortal's the cards into it on demand.
 *
 * Why module-level + useSyncExternalStore rather than React Context:
 *   The Slot is mounted by the *route* (deep in the tree) while the Host is
 *   inside CCAgentSessionView (also deep, but in a sibling subtree of the
 *   route's children). A Context provider would have to be lifted to the
 *   nearest common ancestor (e.g. MainLayout / shell) and pollute every
 *   route. A module-level signal is dependency-free, cleans up on unmount,
 *   and is observed via useSyncExternalStore for proper React 19 behavior.
 *
 * Single-slot policy: only one slot can be active at a time. If a second
 * Slot mounts, it overrides; on unmount the previous slot does NOT come
 * back (we'd need a stack for that, currently unnecessary). Routes are
 * mutually-exclusive in practice so this is fine.
 */

let slotElement: HTMLElement | null = null;
const subscribers = new Set<() => void>();

export function setSlotElement(el: HTMLElement | null): void {
  if (slotElement === el) return;
  slotElement = el;
  for (const cb of subscribers) cb();
}

export function getSlotElement(): HTMLElement | null {
  return slotElement;
}

export function subscribeSlot(cb: () => void): () => void {
  subscribers.add(cb);
  return () => {
    subscribers.delete(cb);
  };
}
