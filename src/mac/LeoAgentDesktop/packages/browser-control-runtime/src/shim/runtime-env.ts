/**
 * Shim: openclaw/plugin-sdk/runtime-env.
 *
 * `registerUnhandledRejectionHandler` is faithfully wired to the Node process.
 * `danger`/`info` are CLI text stylers (identity passthrough). `defaultRuntime`
 * is a minimal runtime descriptor.
 */
type UnhandledRejectionHandler = (reason: unknown, promise: Promise<unknown>) => void;

const handlers = new Set<UnhandledRejectionHandler>();
let installed = false;

// The single `process.on('unhandledRejection')` listener is installed once and
// intentionally lives for the whole process lifetime — it is idempotent and, once
// every caller unregisters (via the returned disposer), simply iterates an empty
// set (no behavioral side effect). Individual handlers ARE removable; only the
// thin dispatch hook is permanent, so there is no listener to leak per call.
function ensureProcessHook(): void {
  if (installed) return;
  installed = true;
  process.on('unhandledRejection', (reason, promise) => {
    for (const h of handlers) {
      try {
        h(reason, promise as Promise<unknown>);
      } catch {
        // never let a handler crash the dispatcher
      }
    }
  });
}

/** Register a process-level unhandled-rejection handler; returns an unregister fn. */
export function registerUnhandledRejectionHandler(handler: UnhandledRejectionHandler): () => void {
  ensureProcessHook();
  handlers.add(handler);
  return () => {
    handlers.delete(handler);
  };
}

export function danger(text: string): string {
  return text;
}

export function info(text: string): string {
  return text;
}

export const defaultRuntime = {
  platform: process.platform,
  isInteractive: false,
};
