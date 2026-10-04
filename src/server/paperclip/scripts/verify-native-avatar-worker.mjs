#!/usr/bin/env node
// Uses the actual compiled worker; no API/model calls or project file writes.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const [expectation, rootArg, tmpArg, ...extra] = process.argv.slice(2);
assert.ok(['broken', 'fixed'].includes(expectation) && rootArg && tmpArg && !extra.length,
  'Usage: node verify-native-avatar-worker.mjs <broken|fixed> <physical source-or-candidate root> <short existing external TMPDIR>');
const root = path.resolve(rootArg);
assert.equal(fs.realpathSync(root), root, 'use the physical source/candidate directory');
const tmpdir = fs.realpathSync(tmpArg);
assert.ok(tmpdir.startsWith('/Volumes/') && Buffer.byteLength(tmpdir) <= 80, 'TMPDIR must be a short external-volume path');
assert.ok(fs.statSync(tmpdir).isDirectory(), 'TMPDIR must exist');
fs.accessSync(tmpdir, fs.constants.W_OK);
process.env.TMPDIR = tmpdir;
const file = path.join(root, 'server/dist/services/agent-avatar-worker.js');
assert.equal(fs.realpathSync(file), file, 'compiled worker must not be a symlink');
const worker = new Worker(pathToFileURL(file), {
  execArgv: ['--import', path.join(root, 'server/node_modules/tsx/dist/loader.mjs')],
  env: { ...process.env, TMPDIR: tmpdir },
});
try {
  const result = await new Promise(resolve => {
    const timer = setTimeout(() => resolve({ error: new Error('avatar worker timed out') }), 10_000);
    const finish = result => { clearTimeout(timer); resolve(result); };
    worker.once('error', error => finish({ error }));
    worker.once('message', message => finish({ message }));
    worker.once('exit', code => finish({ error: new Error(`avatar worker exited: ${code}`) }));
    worker.postMessage({
      appearance: { schemaVersion: 1, characterVersion: 'cap-v1', paletteId: 'deep-tide' },
      size: 64, scale: 1, pose: 'idle', muted: false,
    });
  });
  if (expectation === 'broken') {
    assert.equal(result.error?.code, 'ERR_MODULE_NOT_FOUND', 'expected the source-export regression');
    assert.ok(result.error.message.includes(path.join(root, 'packages/shared/src/cliplab/definition.js')), 'unexpected missing module');
    console.log(JSON.stringify({ expectation, root, tmpdir, reproduced: result.error.code }));
  } else {
    assert.ifError(result.error);
    assert.ok(result.message?.png, result.message?.error ?? 'worker returned no PNG');
    const png = Buffer.from(result.message.png);
    assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', 'PNG signature');
    const require = createRequire(pathToFileURL(file));
    const { default: sharp } = await import(pathToFileURL(require.resolve('sharp')).href);
    const image = await sharp(png).metadata();
    assert.equal(image.format, 'png');
    assert.equal(image.width, 64);
    assert.equal(image.height, 64);
    console.log(JSON.stringify({ expectation, root, tmpdir, pngBytes: png.length, width: image.width, height: image.height }));
  }
} finally {
  await worker.terminate();
}
