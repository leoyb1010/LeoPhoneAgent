import { describe, expect, it } from 'vitest';

import {
  isAppContentWindow,
  isFocusedAppContentWindow,
  markAppContentWindow,
} from '../windowFocusClassifier.js';

function fakeWindow(options: {
  destroyed?: boolean;
  focused?: boolean;
  minimizable?: boolean;
}) {
  return {
    isDestroyed: () => options.destroyed === true,
    isFocused: () => options.focused === true,
    isMinimizable: () => options.minimizable !== false,
  };
}

describe('windowFocusClassifier', () => {
  it('accepts focused registered app windows', () => {
    const win = fakeWindow({ focused: true, minimizable: true });
    markAppContentWindow(win as never);

    expect(isAppContentWindow(win as never)).toBe(true);
    expect(isFocusedAppContentWindow(win as never)).toBe(true);
  });

  it('rejects unregistered utility windows that are not minimizable', () => {
    const win = fakeWindow({ focused: true, minimizable: false });

    expect(isAppContentWindow(win as never)).toBe(false);
    expect(isFocusedAppContentWindow(win as never)).toBe(false);
  });

  it('rejects unregistered OAuth windows even when they are minimizable', () => {
    const win = fakeWindow({ focused: true, minimizable: true });

    expect(isAppContentWindow(win as never)).toBe(false);
    expect(isFocusedAppContentWindow(win as never)).toBe(false);
  });

  it('rejects destroyed windows', () => {
    const win = fakeWindow({ destroyed: true, focused: true, minimizable: true });
    markAppContentWindow(win as never);

    expect(isAppContentWindow(win as never)).toBe(false);
    expect(isFocusedAppContentWindow(win as never)).toBe(false);
  });
});
