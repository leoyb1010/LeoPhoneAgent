/**
 * swallowActivationClick.ts
 * ---------------------------------------------------------------------------
 * Windows-only emulation of macOS' `acceptFirstMouse: false` behavior:
 * when the app window regains focus after being blurred, the first *left*
 * single-click gesture that activates it is treated as *just* an activation
 * gesture and is not delivered to any in-page target (no button firing, no
 * text selection). Subsequent clicks after that gesture behave normally.
 *
 * Scope is deliberately narrow — **only the primary (left) single click** is
 * swallowed. Right-click (context menu), middle-click, and double-click are
 * intentionally NOT intercepted: activating the window with one of those still
 * performs its normal in-page action. This keeps the guard minimal and avoids
 * eating gestures the user may well intend.
 *
 * Split into two layers so the state machine is testable without DOM:
 *   - `createSwallowActivationState()` — pure state machine over event kinds
 *     and timestamps. Returns { handle } where handle(input) → shouldSwallow.
 *   - `installSwallowActivationClick()` — DOM adapter. Feeds only primary-button
 *     mouse events into the state machine and calls preventDefault /
 *     stopImmediatePropagation when it says to swallow. Returns a dispose.
 *
 * On non-Windows platforms `installSwallowActivationClick()` is a no-op —
 * macOS already delivers the correct behavior via `acceptFirstMouse:false`,
 * and Linux WMs don't need it.
 */

// Only the mouse gesture that *activates* a background window should be
// swallowed. The DOM has no way to tell "focus caused by a mouse-activation
// click" from "focus caused by Alt+Tab / taskbar", so we gate on time: the
// OS delivers the activating mousedown within a few ms of the focus event,
// whereas a keyboard refocus (Alt+Tab) followed by a deliberate click is far
// slower. 120ms comfortably covers the same-gesture activation click while
// making it very unlikely to eat a genuine click after a keyboard refocus.
// This is a heuristic, not a guarantee — see the keyboard-refocus test.
const ACTIVATION_WINDOW_MS = 120;
// After the primary button is *released* we keep swallowing for a brief window
// to catch the trailing `click` that completes the same gesture, then reset.
// Crucially this guard only runs once the button is up — while it is still held
// we never time out, so even a long-press activation is swallowed in full
// (a fixed down-to-up timeout would leak the release of a >Nms hold).
const RELEASE_GUARD_MS = 300;

export type SwallowEventKind =
  | 'blur'
  | 'focus'
  | 'pointerdown'
  | 'mousedown'
  | 'pointerup'
  | 'mouseup'
  | 'click';

export interface SwallowInput {
  kind: SwallowEventKind;
  nowMs: number;
}

export interface SwallowActivationState {
  handle(input: SwallowInput): boolean;
}

/**
 * Pure state machine. See file header for the shape it enforces.
 *
 * Tracks two things after a gesture is armed by focus:
 *   - `heldDown`: a swallowed primary-button press is outstanding (button down).
 *     While true we swallow unconditionally and never expire — this is what
 *     makes a long-press activation swallow its eventual release too.
 *   - `releaseGuardUntilMs`: a short window opened on release to swallow the
 *     trailing `click`; only this part is time-bounded.
 *
 * Timing constants are in-module because they are behavioral tuning, not
 * user-visible config.
 */
export function createSwallowActivationState(): SwallowActivationState {
  let wasBlurred = false;
  let armedAt: number | null = null;
  let heldDown = false;
  let releaseGuardUntilMs: number | null = null;

  function handle(input: SwallowInput): boolean {
    const { kind, nowMs } = input;

    if (armedAt !== null && nowMs - armedAt > ACTIVATION_WINDOW_MS) {
      armedAt = null;
    }
    // Release guard only ticks once the button is up; while held, never expire.
    if (!heldDown && releaseGuardUntilMs !== null && nowMs > releaseGuardUntilMs) {
      releaseGuardUntilMs = null;
    }

    if (kind === 'blur') {
      wasBlurred = true;
      armedAt = null;
      heldDown = false;
      releaseGuardUntilMs = null;
      return false;
    }
    if (kind === 'focus') {
      if (wasBlurred) {
        armedAt = nowMs;
      }
      wasBlurred = false;
      return false;
    }

    if (kind === 'pointerdown' || kind === 'mousedown') {
      if (armedAt !== null) {
        // Left press within the activation window — start swallowing the gesture.
        heldDown = true;
        armedAt = null;
        releaseGuardUntilMs = null;
        return true;
      }
      if (heldDown && kind === 'mousedown') {
        // Compat `mousedown` paired with the `pointerdown` already being swallowed.
        return true;
      }
      // A fresh, non-activation press starts a new gesture: clear any stuck
      // held state (e.g. a prior release we never saw) and let it through.
      heldDown = false;
      releaseGuardUntilMs = null;
      return false;
    }

    if (kind === 'pointerup' || kind === 'mouseup') {
      if (heldDown) {
        heldDown = false;
        releaseGuardUntilMs = nowMs + RELEASE_GUARD_MS;
        return true;
      }
      if (releaseGuardUntilMs !== null) {
        return true;
      }
      return false;
    }

    // kind === 'click' — the terminal that ends the gesture.
    if (heldDown || releaseGuardUntilMs !== null) {
      heldDown = false;
      releaseGuardUntilMs = null;
      return true;
    }
    return false;
  }

  return { handle };
}

export interface SwallowInstallTarget {
  window: Pick<Window, 'addEventListener' | 'removeEventListener'>;
  platform: string;
  performanceNow: () => number;
  /**
   * 运行时开关。默认恒开(维持 PR #446 原行为)。如果传入函数则每次事件回调都
   * 会调用它——用户在设置里 toggle 关闭后,下一次点击立刻生效,无需重启;而在
   * 手势中途 toggle 也不会让 preventDefault 半吞半放(状态机不再收到事件,
   * 无残留武装状态)。仅在 platform === 'win32' 时生效。
   */
  isEnabled?: () => boolean;
}

const DOM_EVENT_KINDS = [
  'pointerdown',
  'mousedown',
  'pointerup',
  'mouseup',
  'click',
] as const satisfies readonly Exclude<SwallowEventKind, 'blur' | 'focus'>[];

function resolveDefaultTarget(): SwallowInstallTarget {
  const platform =
    typeof window !== 'undefined' && window.electronAPI
      ? window.electronAPI.platform
      : '';
  return {
    window,
    platform,
    performanceNow: () => performance.now(),
  };
}

/**
 * DOM adapter. Wires the events the state machine needs onto `window` and
 * rewrites swallow decisions into stopImmediatePropagation + preventDefault.
 *
 * Two deliberate choices here:
 *   - Capture phase differs per family: pointer / mouse events register in the
 *     CAPTURE phase so we can swallow the activation gesture before any page
 *     handler; focus / blur register in the BUBBLE phase (capture: false),
 *     because focus/blur do not bubble and a non-capturing window listener only
 *     sees BrowserWindow-level activation. A capturing focus/blur listener
 *     would also fire for descendant control focus changes (input → input,
 *     tabbing fields) and wrongly arm the swallow while already foreground.
 *   - Only the PRIMARY (left) button is fed to the state machine. Right-click
 *     and middle-click events are ignored entirely, so context menus and
 *     middle-click actions still work when the click also activates the window.
 *
 * Returns a dispose that removes every listener registered by this call.
 * When platform !== 'win32', returns a no-op dispose without touching the DOM.
 */
export function installSwallowActivationClick(
  target: SwallowInstallTarget = resolveDefaultTarget(),
): () => void {
  if (target.platform !== 'win32') {
    return (): void => {};
  }

  const state = createSwallowActivationState();
  const registered: Array<{ type: string; listener: EventListener; capture: boolean }> = [];
  const isEnabled = target.isEnabled ?? ((): boolean => true);

  const add = (type: string, listener: EventListener, capture: boolean): void => {
    target.window.addEventListener(type, listener, capture);
    registered.push({ type, listener, capture });
  };

  // focus / blur: bubble phase only — window activation, not descendant focus.
  // 开关关闭时不把 focus/blur 喂给状态机——避免"关闭期间累计的 blurred 标记"
  // 在重新打开后误武装 activation window。
  add('focus', () => {
    if (!isEnabled()) return;
    state.handle({ kind: 'focus', nowMs: target.performanceNow() });
  }, false);
  add('blur', () => {
    if (!isEnabled()) return;
    state.handle({ kind: 'blur', nowMs: target.performanceNow() });
  }, false);

  // pointer / mouse: capture phase so we can swallow before page handlers.
  // Non-primary buttons are passed straight through (button !== 0), so only a
  // left single-click activation is ever swallowed.
  for (const kind of DOM_EVENT_KINDS) {
    add(kind, (event) => {
      if ((event as MouseEvent).button !== 0) return;
      if (!isEnabled()) return;
      const swallow = state.handle({ kind, nowMs: target.performanceNow() });
      if (swallow) {
        event.stopImmediatePropagation();
        event.preventDefault();
      }
    }, true);
  }

  let disposed = false;
  return (): void => {
    if (disposed) return;
    disposed = true;
    for (const { type, listener, capture } of registered) {
      target.window.removeEventListener(type, listener, capture);
    }
  };
}
