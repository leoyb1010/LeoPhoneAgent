// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ secondary: false }));

vi.mock('../secondaryWindow', () => ({
  isSecondaryWindow: () => mocks.secondary,
}));

import {
  _resetRsbWindowStateForTests,
  ensureRsbWindowStateLoaded,
  getRsbWindowUiState,
} from '../rightSidebarWindowState';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('rightSidebarWindowState bootstrap', () => {
  beforeEach(() => {
    mocks.secondary = false;
    _resetRsbWindowStateForTests();
  });

  it('stays unknown until getState resolves, then exposes the detached truth', async () => {
    const state = deferred<{ detached: boolean; lastOpen: boolean; open: boolean }>();
    Object.assign(window, {
      electronAPI: {
        rightSidebarWindow: {
          getState: vi.fn(() => state.promise),
          onStateChanged: vi.fn(() => () => undefined),
        },
      },
    });

    const pending = ensureRsbWindowStateLoaded();
    expect(getRsbWindowUiState()).toEqual({ loaded: false, detached: false, open: false });

    state.resolve({ detached: true, lastOpen: false, open: false });
    await expect(pending).resolves.toEqual({ loaded: true, detached: true, open: false });
    expect(getRsbWindowUiState()).toEqual({ loaded: true, detached: true, open: false });
  });

  it('uses an explicit attached fallback when bootstrap fails', async () => {
    Object.assign(window, {
      electronAPI: {
        rightSidebarWindow: {
          getState: vi.fn(async () => {
            throw new Error('unavailable');
          }),
          onStateChanged: vi.fn(() => () => undefined),
        },
      },
    });

    await expect(ensureRsbWindowStateLoaded()).resolves.toEqual({
      loaded: true,
      detached: false,
      open: false,
    });
  });

  it('treats a cold secondary window as synchronously attached without main bootstrap', async () => {
    mocks.secondary = true;
    const getState = vi.fn();
    const onStateChanged = vi.fn();
    Object.assign(window, {
      electronAPI: { rightSidebarWindow: { getState, onStateChanged } },
    });
    _resetRsbWindowStateForTests();

    expect(getRsbWindowUiState()).toEqual({ loaded: true, detached: false, open: false });
    await expect(ensureRsbWindowStateLoaded()).resolves.toEqual({
      loaded: true,
      detached: false,
      open: false,
    });
    expect(getState).not.toHaveBeenCalled();
    expect(onStateChanged).not.toHaveBeenCalled();
  });
});
