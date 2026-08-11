import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

import { isFirstPartyShellUrl, isTrustedNavigationUrl } from './trustPolicy.js';

const launcherPath = path.resolve('/Applications/leocodebox.app/Contents/Resources/app/electron/launcher/index.html');
const placeholderPath = path.resolve('/Applications/leocodebox.app/Contents/Resources/app/electron/placeholder.html');

test('desktop IPC trusts only the exact bundled launcher file', () => {
  assert.equal(isFirstPartyShellUrl(pathToFileURL(launcherPath).href, launcherPath), true);
  assert.equal(isFirstPartyShellUrl('file:///tmp/electron/launcher/index.html', launcherPath), false);
  assert.equal(isFirstPartyShellUrl('https://leocodebox.local/', launcherPath), false);
});

test('navigation rejects arbitrary local files but permits explicit bundled pages', () => {
  const options = {
    currentUrl: pathToFileURL(launcherPath).href,
    allowedFilePaths: [launcherPath, placeholderPath],
  };

  assert.equal(isTrustedNavigationUrl({ ...options, targetUrl: pathToFileURL(placeholderPath).href }), true);
  assert.equal(isTrustedNavigationUrl({ ...options, targetUrl: 'file:///tmp/untrusted.html' }), false);
});

test('navigation preserves same-origin web routes and fixed app origins', () => {
  assert.equal(isTrustedNavigationUrl({
    currentUrl: 'https://custom.example/workspace',
    targetUrl: 'https://custom.example/settings',
  }), true);
  assert.equal(isTrustedNavigationUrl({ targetUrl: 'http://127.0.0.1:38473/' }), true);
  assert.equal(isTrustedNavigationUrl({ targetUrl: 'https://agent.leocodebox.local/' }), true);
  assert.equal(isTrustedNavigationUrl({ targetUrl: 'https://evil.example/' }), false);
});
