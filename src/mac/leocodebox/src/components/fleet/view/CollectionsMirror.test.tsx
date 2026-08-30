import assert from 'node:assert/strict';
import test from 'node:test';

import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';

import CollectionsMirror from './CollectionsMirror';

function installBrowserStubs(responseStatus = 200) {
  const values = new Map<string, string>();
  const originalFetch = globalThis.fetch;
  const originalWindow = globalThis.window;
  const originalDocument = globalThis.document;
  let focusedId = '';
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, String(value)),
      removeItem: (key: string) => values.delete(key),
      clear: () => values.clear(),
      key: (index: number) => Array.from(values.keys())[index] ?? null,
      get length() { return values.size; },
    } satisfies Storage,
  });
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      setTimeout: (handler: TimerHandler) => {
        queueMicrotask(() => typeof handler === 'function' && handler());
        return 1;
      },
      clearTimeout: () => undefined,
      dispatchEvent: () => true,
      confirm: () => true,
    },
  });
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: { getElementById: (id: string) => ({ focus: () => { focusedId = id; } }) },
  });
  globalThis.fetch = async (url) => {
    const body = String(url).startsWith('/api/leophone/collections')
      ? { items: [] } : { items: [] };
    return new Response(JSON.stringify(responseStatus === 200 ? body : { error: '离线' }), {
      status: responseStatus,
      headers: { 'content-type': 'application/json' },
    });
  };
  return {
    focused: () => focusedId,
    restore: () => {
      globalThis.fetch = originalFetch;
      Object.defineProperty(globalThis, 'window', { configurable: true, value: originalWindow });
      Object.defineProperty(globalThis, 'document', { configurable: true, value: originalDocument });
    },
  };
}

test('Treasury views expose linked keyboard-operable tabs and a live loading boundary', async () => {
  const browser = installBrowserStubs();
  let renderer!: TestRenderer.ReactTestRenderer;
  try {
    await act(async () => {
      renderer = TestRenderer.create(<CollectionsMirror />);
      await Promise.resolve();
      await Promise.resolve();
    });
    const tabs = renderer.root.findAll((node) => node.props.role === 'tab');
    assert.equal(tabs.length, 6);
    assert.equal(tabs[0]?.props.id, 'treasury-view-inbox');
    assert.equal(tabs[0]?.props['aria-controls'], 'treasury-results');
    assert.equal(tabs[0]?.props.tabIndex, 0);
    assert.equal(tabs[1]?.props.tabIndex, -1);
    const panel = renderer.root.find((node) => node.props.role === 'tabpanel');
    assert.equal(panel.props.id, 'treasury-results');
    assert.equal(panel.props['aria-labelledby'], 'treasury-view-inbox');

    act(() => tabs[0]?.props.onKeyDown({ key: 'ArrowRight', preventDefault: () => undefined }));
    const selected = renderer.root.findAll((node) => node.props.role === 'tab')
      .find((node) => node.props['aria-selected']);
    assert.equal(selected?.props.id, 'treasury-view-processing');
    assert.equal(browser.focused(), 'treasury-view-processing');
  } finally {
    if (renderer) act(() => renderer.unmount());
    browser.restore();
  }
});

test('Treasury load failures use assertive alert semantics', async () => {
  const browser = installBrowserStubs(503);
  let renderer!: TestRenderer.ReactTestRenderer;
  try {
    await act(async () => {
      renderer = TestRenderer.create(<CollectionsMirror />);
      await Promise.resolve();
      await Promise.resolve();
    });
    const alert = renderer.root.find((node) => node.props.role === 'alert');
    assert.equal(alert.props['aria-live'], 'assertive');
  } finally {
    if (renderer) act(() => renderer.unmount());
    browser.restore();
  }
});
