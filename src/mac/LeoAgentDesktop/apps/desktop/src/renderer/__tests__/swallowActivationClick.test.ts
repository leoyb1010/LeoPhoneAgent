/**
 * swallowActivationClick.test.ts
 * ---------------------------------------------------------------------------
 * Locks in the state machine and DOM adapter behavior for the Windows-only
 * activation-click swallow (macOS `acceptFirstMouse: false` emulation).
 * Scope is intentionally narrow: only the primary (left) single click is
 * swallowed; right/middle/double clicks are passed through. The state machine
 * is pure and covers most of the surface; the adapter tests guard the platform
 * gate, listener wiring, and the primary-button filter.
 */

import { describe, expect, it, vi } from 'vitest';

import {
  createSwallowActivationState,
  installSwallowActivationClick,
  type SwallowEventKind,
} from '../lib/swallowActivationClick';

describe('createSwallowActivationState', () => {
  it('blur → focus → down within the activation window swallows the whole gesture', () => {
    const state = createSwallowActivationState();

    expect(state.handle({ kind: 'blur', nowMs: 0 })).toBe(false);
    expect(state.handle({ kind: 'focus', nowMs: 1_000 })).toBe(false);

    // Activation gesture — pointerdown → mousedown → pointerup → mouseup → click.
    expect(state.handle({ kind: 'pointerdown', nowMs: 1_010 })).toBe(true);
    expect(state.handle({ kind: 'mousedown', nowMs: 1_011 })).toBe(true);
    expect(state.handle({ kind: 'pointerup', nowMs: 1_050 })).toBe(true);
    expect(state.handle({ kind: 'mouseup', nowMs: 1_051 })).toBe(true);
    expect(state.handle({ kind: 'click', nowMs: 1_052 })).toBe(true);

    // Any later click should NOT be swallowed — activation gesture is over.
    expect(state.handle({ kind: 'pointerdown', nowMs: 2_000 })).toBe(false);
    expect(state.handle({ kind: 'click', nowMs: 2_050 })).toBe(false);
  });

  it('focus without a prior blur does not arm the swallow', () => {
    const state = createSwallowActivationState();

    // No blur first — window was already focused.
    expect(state.handle({ kind: 'focus', nowMs: 0 })).toBe(false);
    expect(state.handle({ kind: 'pointerdown', nowMs: 10 })).toBe(false);
    expect(state.handle({ kind: 'mousedown', nowMs: 11 })).toBe(false);
    expect(state.handle({ kind: 'click', nowMs: 30 })).toBe(false);
  });

  it('down > 120ms after focus does not swallow (Alt+Tab then leisurely click)', () => {
    const state = createSwallowActivationState();

    state.handle({ kind: 'blur', nowMs: 0 });
    state.handle({ kind: 'focus', nowMs: 1_000 });

    // 300ms after focus — well outside the 120ms activation window.
    expect(state.handle({ kind: 'pointerdown', nowMs: 1_300 })).toBe(false);
    expect(state.handle({ kind: 'mousedown', nowMs: 1_301 })).toBe(false);
    expect(state.handle({ kind: 'click', nowMs: 1_320 })).toBe(false);
  });

  it('keyboard refocus (Alt+Tab) then a click at 150ms is NOT swallowed', () => {
    // Regression for the P1 review finding: focus also fires on Alt+Tab /
    // taskbar refocus, which is not a mouse activation. A deliberate click
    // shortly after (here 150ms — inside the old 250ms window, outside the
    // tightened 120ms one) must reach the page. The mouse-activation click
    // arrives within a few ms of focus, so tightening the window preserves
    // the intended behavior while no longer eating this keyboard-refocus click.
    const state = createSwallowActivationState();

    state.handle({ kind: 'blur', nowMs: 0 });
    state.handle({ kind: 'focus', nowMs: 1_000 });

    expect(state.handle({ kind: 'pointerdown', nowMs: 1_150 })).toBe(false);
    expect(state.handle({ kind: 'mousedown', nowMs: 1_151 })).toBe(false);
    expect(state.handle({ kind: 'click', nowMs: 1_170 })).toBe(false);
  });

  it('long-press activation still swallows the release + click after the hold', () => {
    // Regression for the long-press review finding: while the primary button is
    // held there is no timeout, so a hold far longer than any fixed cap still
    // has its eventual mouseup/click swallowed as part of the same gesture.
    const state = createSwallowActivationState();

    state.handle({ kind: 'blur', nowMs: 0 });
    state.handle({ kind: 'focus', nowMs: 100 });

    expect(state.handle({ kind: 'pointerdown', nowMs: 110 })).toBe(true);
    // Held for ~2s before release — must still be swallowed.
    expect(state.handle({ kind: 'pointerup', nowMs: 2_100 })).toBe(true);
    expect(state.handle({ kind: 'mouseup', nowMs: 2_101 })).toBe(true);
    expect(state.handle({ kind: 'click', nowMs: 2_110 })).toBe(true);

    // Gesture is over — a later independent press passes through.
    expect(state.handle({ kind: 'pointerdown', nowMs: 3_000 })).toBe(false);
  });

  it('a fresh non-activation press clears a stuck held state (release seen off-window)', () => {
    // If the release happened off-window (no up/click reached us), heldDown could
    // linger. The next fresh pointerdown that isn't an activation must clear it
    // and pass through rather than being eaten.
    const state = createSwallowActivationState();

    state.handle({ kind: 'blur', nowMs: 0 });
    state.handle({ kind: 'focus', nowMs: 100 });
    expect(state.handle({ kind: 'pointerdown', nowMs: 110 })).toBe(true); // held, never released here

    // Much later, a brand-new left press (window already foreground, not armed).
    expect(state.handle({ kind: 'pointerdown', nowMs: 5_000 })).toBe(false);
    expect(state.handle({ kind: 'mousedown', nowMs: 5_001 })).toBe(false);
    expect(state.handle({ kind: 'click', nowMs: 5_020 })).toBe(false);
  });

  it('re-blur mid-armed re-arms cleanly on the second focus (one activation cycle)', () => {
    const state = createSwallowActivationState();

    state.handle({ kind: 'blur', nowMs: 0 });
    state.handle({ kind: 'focus', nowMs: 100 });
    // Blur again resets. Then focus re-arms — this is one activation cycle.
    state.handle({ kind: 'blur', nowMs: 200 });
    state.handle({ kind: 'focus', nowMs: 300 });
    expect(state.handle({ kind: 'pointerdown', nowMs: 310 })).toBe(true);
    expect(state.handle({ kind: 'click', nowMs: 340 })).toBe(true);
  });
});

describe('installSwallowActivationClick (DOM adapter)', () => {
  function makeWindow(): {
    addEventListener: ReturnType<typeof vi.fn>;
    removeEventListener: ReturnType<typeof vi.fn>;
    listeners: Map<string, EventListener>;
    captureByType: Map<string, boolean>;
  } {
    const listeners = new Map<string, EventListener>();
    const captureByType = new Map<string, boolean>();
    return {
      addEventListener: vi.fn((type: string, listener: EventListener, capture?: boolean) => {
        listeners.set(type, listener);
        captureByType.set(type, capture === true);
      }),
      removeEventListener: vi.fn(),
      listeners,
      captureByType,
    };
  }

  // focus/blur must be bubble-phase (false) so descendant control focus changes
  // don't arm the swallow; pointer/mouse must be capture-phase (true). Only the
  // primary-button gestures are wired — no auxclick/dblclick/contextmenu.
  const CAPTURE_BY_TYPE: Record<string, boolean> = {
    focus: false,
    blur: false,
    pointerdown: true,
    mousedown: true,
    pointerup: true,
    mouseup: true,
    click: true,
  };

  it('is a no-op on non-win32 platforms — no listeners registered', () => {
    for (const platform of ['darwin', 'linux', 'freebsd', '']) {
      const win = makeWindow();
      const dispose = installSwallowActivationClick({
        window: win,
        platform,
        performanceNow: () => 0,
      });
      expect(win.addEventListener).not.toHaveBeenCalled();
      dispose(); // still safe to call
      expect(win.removeEventListener).not.toHaveBeenCalled();
    }
  });

  it('on win32 wires focus/blur (bubble) and the pointer/mouse family (capture) only', () => {
    const win = makeWindow();
    installSwallowActivationClick({
      window: win,
      platform: 'win32',
      performanceNow: () => 0,
    });

    const expectedTypes = Object.keys(CAPTURE_BY_TYPE);
    expect(win.addEventListener).toHaveBeenCalledTimes(expectedTypes.length);
    for (const type of expectedTypes) {
      expect(win.listeners.has(type)).toBe(true);
      // pointer/mouse in capture phase, focus/blur in bubble phase.
      expect(win.captureByType.get(type)).toBe(CAPTURE_BY_TYPE[type]);
    }
    // Right/middle-click specific events are intentionally NOT wired.
    for (const type of ['auxclick', 'dblclick', 'contextmenu']) {
      expect(win.listeners.has(type)).toBe(false);
    }
  });

  it('swallows a primary-button activation click, passes through non-primary buttons', () => {
    const win = makeWindow();
    let now = 0;
    installSwallowActivationClick({
      window: win,
      platform: 'win32',
      performanceNow: () => now,
    });

    function fire(kind: SwallowEventKind, button = 0): {
      stopImmediatePropagation: ReturnType<typeof vi.fn>;
      preventDefault: ReturnType<typeof vi.fn>;
    } {
      const stopImmediatePropagation = vi.fn();
      const preventDefault = vi.fn();
      const event = { stopImmediatePropagation, preventDefault, button } as unknown as Event;
      const listener = win.listeners.get(kind);
      if (!listener) throw new Error(`no listener for ${kind}`);
      listener(event);
      return { stopImmediatePropagation, preventDefault };
    }

    now = 0;
    fire('blur');
    now = 1_000;
    fire('focus');

    // Primary (left) button — swallowed.
    now = 1_010;
    const down = fire('pointerdown', 0);
    expect(down.stopImmediatePropagation).toHaveBeenCalledTimes(1);
    expect(down.preventDefault).toHaveBeenCalledTimes(1);

    now = 1_050;
    const click = fire('click', 0);
    expect(click.stopImmediatePropagation).toHaveBeenCalledTimes(1);
    expect(click.preventDefault).toHaveBeenCalledTimes(1);

    // A separate later click passes through untouched.
    now = 3_000;
    const passthrough = fire('click', 0);
    expect(passthrough.stopImmediatePropagation).not.toHaveBeenCalled();
    expect(passthrough.preventDefault).not.toHaveBeenCalled();
  });

  it('does not swallow right-click or middle-click activation (button !== 0)', () => {
    const win = makeWindow();
    let now = 0;
    installSwallowActivationClick({
      window: win,
      platform: 'win32',
      performanceNow: () => now,
    });

    function fire(kind: SwallowEventKind, button: number): ReturnType<typeof vi.fn> {
      const stopImmediatePropagation = vi.fn();
      const preventDefault = vi.fn();
      const event = { stopImmediatePropagation, preventDefault, button } as unknown as Event;
      win.listeners.get(kind)?.(event);
      return preventDefault;
    }

    now = 0;
    fire('blur', 0);
    now = 1_000;
    fire('focus', 0);

    // Middle button (1) and right button (2) presses right after activation:
    // never fed to the state machine, so never swallowed.
    now = 1_010;
    expect(fire('mousedown', 1)).not.toHaveBeenCalled();
    expect(fire('pointerdown', 2)).not.toHaveBeenCalled();
    expect(fire('mouseup', 1)).not.toHaveBeenCalled();

    // The primary click of a subsequent, unrelated left gesture is also not
    // swallowed here because the right/middle press never armed anything and
    // the activation window has since elapsed.
    now = 1_200;
    expect(fire('click', 0)).not.toHaveBeenCalled();
  });

  it('isEnabled=false short-circuits every event — nothing is swallowed even in the activation window', () => {
    const win = makeWindow();
    let now = 0;
    let enabled = false;
    installSwallowActivationClick({
      window: win,
      platform: 'win32',
      performanceNow: () => now,
      isEnabled: () => enabled,
    });

    function fire(kind: SwallowEventKind, button = 0): ReturnType<typeof vi.fn> {
      const stopImmediatePropagation = vi.fn();
      const preventDefault = vi.fn();
      const event = { stopImmediatePropagation, preventDefault, button } as unknown as Event;
      win.listeners.get(kind)?.(event);
      return preventDefault;
    }

    // 关闭态下:即使经历 blur → focus → 首次 pointerdown/click,adapter 一律不吞。
    now = 0;
    fire('blur');
    now = 1_000;
    fire('focus');
    now = 1_010;
    expect(fire('pointerdown', 0)).not.toHaveBeenCalled();
    expect(fire('click', 0)).not.toHaveBeenCalled();

    // 用户 mid-session 打开开关后,状态机没吃过关闭期间的 focus/blur,不会误武装
    // ——下一次真正的 blur → focus → down 才应该吞。
    enabled = true;
    now = 2_000;
    // 已经 focus 过,没有新的 blur/focus,依旧不吞。
    expect(fire('pointerdown', 0)).not.toHaveBeenCalled();

    now = 2_500;
    fire('blur');
    now = 3_000;
    fire('focus');
    now = 3_010;
    expect(fire('pointerdown', 0)).toHaveBeenCalledTimes(1);
  });

  it('dispose removes every listener it registered (capture flag preserved)', () => {
    const win = makeWindow();
    const dispose = installSwallowActivationClick({
      window: win,
      platform: 'win32',
      performanceNow: () => 0,
    });
    const addedCount = win.addEventListener.mock.calls.length;

    dispose();
    expect(win.removeEventListener).toHaveBeenCalledTimes(addedCount);
    for (const call of win.removeEventListener.mock.calls) {
      const [type, , capture] = call;
      // removed with the SAME capture flag it was added with, else the
      // listener would leak (addEventListener/removeEventListener key on it).
      expect(capture).toBe(CAPTURE_BY_TYPE[type]);
    }

    // Idempotent.
    dispose();
    expect(win.removeEventListener).toHaveBeenCalledTimes(addedCount);
  });
});
