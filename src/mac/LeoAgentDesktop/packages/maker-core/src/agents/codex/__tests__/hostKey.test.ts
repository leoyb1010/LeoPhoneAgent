/**
 * Tests for hostKey — the function that maps a (potentially-remote) session
 * to the AppServerHost instance it should share.
 *
 * Why this test matters:
 *   CodexAgent keeps one AppServerHost per "target" (local spawn vs each
 *   distinct remote ssh host). The host map is keyed by hostKey(remoteHostId).
 *   A bug here breaks one of two ways:
 *
 *   - Wrong key → two sessions on the same remoteHostId spawn TWO daemons
 *     bridges, doubling per-session network/cpu cost and (worse) producing
 *     two unrelated thread namespaces — resume across them is impossible
 *     and the second daemon "ghosts" until process exit.
 *   - Same key → distinct remoteHostIds collide on one host, second
 *     session's prompts go to first session's daemon = wrong machine.
 *
 *   Falsy remoteHostId MUST collapse to 'local' (a missing remote id is
 *   always "this machine", never an empty-string remote alias). Anything
 *   non-falsy MUST be prefixed with 'remote:' so the keyspace can never
 *   collide with the literal 'local' key.
 */

import { describe, expect, it } from 'vitest';

import { hostKey } from '../index.js';

describe('hostKey', () => {
  it('returns "local" for undefined remoteHostId', () => {
    expect(hostKey(undefined)).toBe('local');
  });

  it('returns "local" for null remoteHostId', () => {
    expect(hostKey(null)).toBe('local');
  });

  it('returns "local" for empty string remoteHostId', () => {
    // Empty string is falsy; a missing id must always read as local, never
    // be elevated to a remote alias whose name happens to be ''.
    expect(hostKey('')).toBe('local');
  });

  it('returns "remote:<id>" for a non-empty remoteHostId', () => {
    expect(hostKey('builder09')).toBe('remote:builder09');
  });

  it('preserves arbitrary id contents (no escaping, no truncation)', () => {
    // ids come from user-controlled host alias. The function must NOT munge
    // them — equality between hostKey calls is what the map relies on.
    expect(hostKey('my host with spaces')).toBe('remote:my host with spaces');
    expect(hostKey('host.with.dots:2222')).toBe('remote:host.with.dots:2222');
  });

  it('produces distinct keys for distinct remoteHostIds', () => {
    expect(hostKey('a')).not.toBe(hostKey('b'));
  });

  it('local key never collides with any remote key, even one literally named "local"', () => {
    // A remote alias the user happens to call "local" must NOT shadow the
    // actual local spawn — the 'remote:' prefix is the guarantee.
    expect(hostKey('local')).toBe('remote:local');
    expect(hostKey('local')).not.toBe(hostKey(undefined));
  });

  it('returns the same key for repeated calls with the same id', () => {
    // Load-bearing for the host map: two getHost() calls with the same id
    // must hit the same map entry, otherwise we'd spawn parallel daemons.
    expect(hostKey('builder09')).toBe(hostKey('builder09'));
  });
});
