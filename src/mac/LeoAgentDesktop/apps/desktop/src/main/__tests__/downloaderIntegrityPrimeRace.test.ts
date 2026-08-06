/**
 * downloaderIntegrityPrimeRace.test.ts
 * ---------------------------------------------------------------------------
 * Regression test for the prime/append race in unified-downloader/integrity.ts.
 *
 * Background:
 *   When a download resumes, transport.ts opens the existing `.part` file in
 *   append mode AND simultaneously hands the same path to
 *   `createStreamingHasher` to be primed. If the prime read isn't bounded to
 *   the file size at construction time, `fs.createReadStream` will keep
 *   reading past the original EOF as the writer appends — meaning the appended
 *   bytes get hashed TWICE (once during prime, once via update()), producing
 *   a guaranteed CHECKSUM mismatch on every resumed download.
 *
 *   That shipped-to-prod bug would surface as: any user whose download is
 *   interrupted and resumed will hit CHECKSUM, which is non-retryable, killing
 *   the whole download. This test pins the fix in place.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createStreamingHasher, computeHash } from '../downloader/integrity';

let workDir: string;

beforeEach(() => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dl-prime-race-'));
});

afterEach(() => {
  try {
    fs.rmSync(workDir, { recursive: true, force: true });
  } catch {
    /* best-effort cleanup */
  }
});

describe('createStreamingHasher — bounded prime read', () => {
  it('does NOT re-hash bytes appended to the .part file after construction', async () => {
    // Setup: write 1 MB of "existing" .part content, then construct the hasher.
    const partPath = path.join(workDir, 'file.bin.part');
    const existing = crypto.randomBytes(1024 * 1024); // 1 MB
    fs.writeFileSync(partPath, existing);

    const hasher = createStreamingHasher(partPath);

    // Race: while the prime read is in flight, append fresh bytes to the
    // SAME file (this is exactly what transport.ts does in resume mode —
    // it opens fs.createWriteStream(partPath, { flags: 'a' }) the moment
    // the HTTP response arrives).
    const appended = crypto.randomBytes(1024 * 1024); // 1 MB of "live" chunks
    fs.appendFileSync(partPath, appended);

    // Now feed the same `appended` bytes through update() — this is what the
    // 'data' handler does in transport.ts. If prime was unbounded, the
    // appended bytes were already hashed during prime, so feeding them again
    // here will produce a hash of (existing + appended + appended) instead of
    // (existing + appended).
    await hasher.update(appended);

    const got = await hasher.digest();

    // Expected: SHA256 of (existing ++ appended) — each byte hashed exactly once.
    const expected = crypto
      .createHash('sha256')
      .update(existing)
      .update(appended)
      .digest('hex');

    expect(got).toBe(expected);
  });

  it('handles an empty .part file without deadlocking', async () => {
    const partPath = path.join(workDir, 'empty.bin.part');
    fs.writeFileSync(partPath, Buffer.alloc(0));

    const hasher = createStreamingHasher(partPath);
    const live = Buffer.from('hello world');
    await hasher.update(live);
    const got = await hasher.digest();

    const expected = crypto.createHash('sha256').update(live).digest('hex');
    expect(got).toBe(expected);
  });

  it('null path → starts fresh, only hashes update() chunks', async () => {
    const hasher = createStreamingHasher(null);
    const live = Buffer.from('claude rocks');
    await hasher.update(live);
    const got = await hasher.digest();
    expect(got).toBe(crypto.createHash('sha256').update(live).digest('hex'));
  });

  it('matches computeHash() for a fully-primed file with no live updates', async () => {
    // Sanity: prime-only path (no update calls) must equal the one-shot helper.
    const filePath = path.join(workDir, 'frozen.bin');
    const body = crypto.randomBytes(512 * 1024);
    fs.writeFileSync(filePath, body);

    const hasher = createStreamingHasher(filePath);
    const streamingDigest = await hasher.digest();
    const oneShotDigest = await computeHash(filePath);

    expect(streamingDigest).toBe(oneShotDigest);
  });
});
