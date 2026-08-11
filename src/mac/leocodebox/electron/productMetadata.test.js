import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { readProductVersion } from './productMetadata.js';

test('reads the product version from the application package metadata', () => {
  const appRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'leocodebox-version-'));
  fs.writeFileSync(path.join(appRoot, 'package.json'), JSON.stringify({ version: '1.1.3' }));

  try {
    assert.equal(readProductVersion(appRoot, '43.1.0'), '1.1.3');
  } finally {
    fs.rmSync(appRoot, { recursive: true, force: true });
  }
});

test('falls back when package metadata is missing or invalid', () => {
  assert.equal(readProductVersion('/missing/leocodebox', '43.1.0'), '43.1.0');
});
