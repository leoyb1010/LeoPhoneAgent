/**
 * Ephemeral renderer-local handoff for the New Maker shortcut.
 *
 * Only a currently visible collaboration panel subscribes. The request is never persisted or
 * replayed: if no visible panel accepts it, the caller keeps the normal New Maker behavior.
 */

export type NewWorkerShortcutHandler = () => boolean | Promise<boolean>;

const handlers = new Set<NewWorkerShortcutHandler>();

export function subscribeNewWorkerShortcut(handler: NewWorkerShortcutHandler): () => void {
  handlers.add(handler);
  return () => handlers.delete(handler);
}

export async function requestNewWorkerFromShortcut(): Promise<boolean> {
  for (const handler of [...handlers]) {
    if (await handler()) return true;
  }
  return false;
}
