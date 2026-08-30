import assert from 'node:assert/strict';
import test from 'node:test';

import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import i18next from 'i18next';
import { I18nextProvider } from 'react-i18next';

import StorageSettingsTab from './StorageSettingsTab';

const i18n = i18next.createInstance();
await i18n.init({ lng: 'en', fallbackLng: 'en', resources: { en: { settings: {} } } });

const renderTab = () => (
  <I18nextProvider i18n={i18n}>
    <StorageSettingsTab />
  </I18nextProvider>
);

function installBrowserStubs(status = 200) {
  const originalFetch = globalThis.fetch;
  const originalWindow = globalThis.window;
  const urls: string[] = [];
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: () => null,
      setItem: () => undefined,
      removeItem: () => undefined,
      clear: () => undefined,
      key: () => null,
      length: 0,
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
    },
  });
  globalThis.fetch = async (input) => {
    urls.push(String(input));
    const payload = status === 200 ? {
      usage: {
        original_bytes: 31,
        original_files: 1,
        body_cache_bytes: 17,
        body_cache_entries: 2,
        attachment_cache_bytes: 13,
        attachment_cache_files: 1,
        attachment_cache_entries: 1,
      },
    } : { error: 'storage unavailable' };
    return new Response(JSON.stringify(payload), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  };
  return {
    urls,
    restore: () => {
      globalThis.fetch = originalFetch;
      Object.defineProperty(globalThis, 'window', { configurable: true, value: originalWindow });
    },
  };
}

test('Mac Treasury storage settings render read-only originals and separate cache actions', async () => {
  const browser = installBrowserStubs();
  let renderer!: TestRenderer.ReactTestRenderer;
  try {
    await act(async () => {
      renderer = TestRenderer.create(renderTab());
      await Promise.resolve();
      await Promise.resolve();
    });
    assert.deepEqual(browser.urls, ['/api/treasury/storage']);
    const buttons = renderer.root.findAllByType('button');
    assert.equal(buttons.length, 3);
    assert.equal(buttons.filter((button) => button.props.disabled === false).length, 3);
    const text = renderer.root.findAllByType('span').map((node) => node.children.join(' ')).join(' ');
    assert.match(text, /31 B/);
    assert.match(text, /17 B/);
    assert.match(text, /13 B/);
  } finally {
    if (renderer) act(() => renderer.unmount());
    browser.restore();
  }
});

test('Mac Treasury storage settings expose load failures as an alert', async () => {
  const browser = installBrowserStubs(500);
  let renderer!: TestRenderer.ReactTestRenderer;
  try {
    await act(async () => {
      renderer = TestRenderer.create(renderTab());
      await Promise.resolve();
      await Promise.resolve();
    });
    const alert = renderer.root.find((node) => node.props.role === 'alert');
    assert.match(alert.children.join(' '), /Unable to read Treasury storage usage/);
  } finally {
    if (renderer) act(() => renderer.unmount());
    browser.restore();
  }
});
