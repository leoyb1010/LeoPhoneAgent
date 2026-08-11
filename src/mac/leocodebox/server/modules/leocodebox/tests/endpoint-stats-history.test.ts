import assert from 'node:assert/strict';
import test from 'node:test';

import { appendEndpointSamples, ENDPOINT_HISTORY_LIMIT } from '../provider-store.service.js';

const result = (url: string, latencyMs: number, usable = true) => ({
  url,
  latencyMs,
  httpStatus: usable ? 200 : 401,
  authStatus: usable ? 'ok' : 'unauthorized',
  usable,
});

test('first round from empty stats seeds a one-sample history and flat latest', () => {
  const stats = appendEndpointSamples({}, [result('https://a', 120)]);
  const entry = stats['https://a'];
  assert.equal(entry.schemaVersion, 1);
  assert.equal(entry.history.length, 1);
  assert.equal(entry.latencyMs, 120);
  assert.equal(entry.history[0].latencyMs, 120);
  // Flat top-level fields mirror the newest sample (keeps existing readers working).
  assert.equal(entry.latencyMs, entry.history[entry.history.length - 1].latencyMs);
});

test('history is a rolling buffer capped at ENDPOINT_HISTORY_LIMIT keeping the newest', () => {
  let stats: Record<string, ReturnType<typeof appendEndpointSamples>[string]> = {};
  for (let i = 1; i <= ENDPOINT_HISTORY_LIMIT + 5; i += 1) {
    stats = appendEndpointSamples(stats, [result('https://a', i)]);
  }
  const entry = stats['https://a'];
  assert.equal(entry.history.length, ENDPOINT_HISTORY_LIMIT);
  // Oldest samples (1..5) were evicted; newest value wins the flat field.
  assert.equal(entry.history[0].latencyMs, 6);
  assert.equal(entry.history[entry.history.length - 1].latencyMs, ENDPOINT_HISTORY_LIMIT + 5);
  assert.equal(entry.latencyMs, ENDPOINT_HISTORY_LIMIT + 5);
});

test('legacy flat records (no schemaVersion/history) migrate without throwing', () => {
  const legacy = { 'https://a': { latencyMs: 90, httpStatus: 200, authStatus: 'ok', usable: true, testedAt: 'x' } };
  const stats = appendEndpointSamples(legacy as never, [result('https://a', 130)]);
  const entry = stats['https://a'];
  assert.equal(entry.history.length, 1);
  assert.equal(entry.history[0].latencyMs, 130);
  assert.equal(entry.schemaVersion, 1);
});

test('null/undefined prior stats are tolerated', () => {
  assert.doesNotThrow(() => appendEndpointSamples(null, [result('https://a', 100)]));
  assert.doesNotThrow(() => appendEndpointSamples(undefined, [result('https://a', 100)]));
});

test('flat latest fields always reflect the newest sample across usable flips', () => {
  let stats = appendEndpointSamples({}, [result('https://a', 100, true)]);
  stats = appendEndpointSamples(stats, [result('https://a', 500, false)]);
  const entry = stats['https://a'];
  assert.equal(entry.usable, false);
  assert.equal(entry.httpStatus, 401);
  assert.equal(entry.latencyMs, 500);
  assert.equal(entry.history.length, 2);
});
