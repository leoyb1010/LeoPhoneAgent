import type { WindowsCloseBehavior } from '../shared/windowBehavior.js';

/** Injectable side effects for the renderer-first Windows close prompt flow. */
export interface WindowsClosePromptFallbackDependencies {
  readBehavior(): WindowsCloseBehavior | null;
  showRendererPrompt(): void;
  showNativePrompt(): WindowsCloseBehavior;
  persistBehavior(behavior: WindowsCloseBehavior): void;
  applyBehavior(behavior: WindowsCloseBehavior): void;
  schedule(callback: () => void, delayMs: number): unknown;
  cancel(handle: unknown): void;
}

/** Lifecycle exposed to the Electron adapter for requests, renderer ACKs, and shutdown. */
export interface WindowsClosePromptFallbackController {
  request(): void;
  acknowledge(): void;
  dispose(): void;
}

/**
 * Prefer the Cindy renderer dialog, but fall back to a native prompt if the renderer never
 * confirms that the dialog mounted. This keeps first-close reliable during startup or crashes.
 */
export function createWindowsClosePromptFallbackController(
  deps: WindowsClosePromptFallbackDependencies,
  fallbackDelayMs: number,
): WindowsClosePromptFallbackController {
  let fallbackHandle: unknown;

  const cancelFallback = (): void => {
    if (fallbackHandle === undefined) return;
    deps.cancel(fallbackHandle);
    fallbackHandle = undefined;
  };

  const runFallback = (): void => {
    fallbackHandle = undefined;
    if (deps.readBehavior()) return;

    const behavior = deps.showNativePrompt();
    // The renderer can persist a choice while the native dialog is open; keep the first choice.
    if (deps.readBehavior()) return;
    deps.persistBehavior(behavior);
    deps.applyBehavior(behavior);
  };

  return {
    request() {
      if (deps.readBehavior()) return;
      deps.showRendererPrompt();
      if (fallbackHandle !== undefined) return;
      fallbackHandle = deps.schedule(runFallback, fallbackDelayMs);
    },
    acknowledge() {
      cancelFallback();
    },
    dispose() {
      cancelFallback();
    },
  };
}
