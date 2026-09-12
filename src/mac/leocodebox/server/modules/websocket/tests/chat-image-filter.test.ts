import assert from 'node:assert/strict';
import os from 'node:os';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { filterImagesToUploadStore, validateQueuedImageReferences } from '@/modules/websocket/services/chat-websocket.service.js';

const STORE = path.join(os.tmpdir(), 'cloudcli-assets-store');

test('images inside the upload store pass through', () => {
  const inside = path.join(STORE, 'shot.png');
  const result = filterImagesToUploadStore(
    [{ path: inside, name: 'shot.png', mimeType: 'image/png' }],
    STORE,
  );
  assert.equal(result.length, 1);
  assert.equal(result[0].path, inside);
});

test('bare filenames are anchored inside the store', () => {
  const result = filterImagesToUploadStore(['shot.png'], STORE);
  assert.equal(result.length, 1);
});

test('paths outside the store, traversal, and subdirs are dropped', () => {
  const result = filterImagesToUploadStore(
    [
      { path: 'C:/Users/victim/.ssh/id_rsa' },
      { path: '/etc/passwd' },
      { path: '../outside.png' },
      { path: path.join(STORE, '..', 'escaped.png') },
      { path: path.join(STORE, 'nested', 'deep.png') },
      { path: STORE }, // the store folder itself is not a file
    ],
    STORE,
  );
  assert.deepEqual(result, []);
});

test('malformed payloads yield no images', () => {
  assert.deepEqual(filterImagesToUploadStore(undefined, STORE), []);
  assert.deepEqual(filterImagesToUploadStore('nope', STORE), []);
  assert.deepEqual(filterImagesToUploadStore([{ name: 'no-path' }, 42], STORE), []);
});


test('queued attachment validation rejects a symlink that escaped the upload store', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'queue-attachment-'));
  const store = path.join(directory, 'assets');
  try {
    await mkdir(store);
    await writeFile(path.join(directory, 'outside.png'), 'fixture');
    await symlink(path.join(directory, 'outside.png'), path.join(store, 'replaced.png'));
    await assert.rejects(validateQueuedImageReferences([{ path: path.join(store, 'replaced.png') }], store), /INVALID_ATTACHMENT/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('queued attachment validation checks that the referenced file still exists before execution', async () => {
  const store = await mkdtemp(path.join(os.tmpdir(), 'queue-attachment-'));
  try {
    const image = path.join(store, 'valid.png');
    await writeFile(image, 'fixture');
    assert.equal((await validateQueuedImageReferences([{ path: image }], store)).length, 1);
    await rm(image);
    await assert.rejects(validateQueuedImageReferences([{ path: image }], store));
  } finally { await rm(store, { recursive: true, force: true }); }
});
