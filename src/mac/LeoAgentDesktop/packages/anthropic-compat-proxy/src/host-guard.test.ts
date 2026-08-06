import { describe, expect, it } from 'vitest';

import { ALLOW_NON_LOOPBACK_ENV, isLoopbackHost, resolveListenHost } from './host-guard.js';

describe('isLoopbackHost', () => {
  it('accepts the exact loopback addresses', () => {
    expect(isLoopbackHost('127.0.0.1')).toBe(true);
    expect(isLoopbackHost('::1')).toBe(true);
    expect(isLoopbackHost('localhost')).toBe(true);
  });

  it('is case-insensitive and tolerates surrounding whitespace', () => {
    expect(isLoopbackHost('LOCALHOST')).toBe(true);
    expect(isLoopbackHost('  127.0.0.1  ')).toBe(true);
    expect(isLoopbackHost('::1\n')).toBe(true);
  });

  it('rejects wildcard / all-interfaces addresses', () => {
    expect(isLoopbackHost('0.0.0.0')).toBe(false);
    expect(isLoopbackHost('::')).toBe(false);
  });

  it('rejects public / LAN IPs and hostnames', () => {
    expect(isLoopbackHost('192.168.1.10')).toBe(false);
    expect(isLoopbackHost('10.0.0.5')).toBe(false);
    expect(isLoopbackHost('8.8.8.8')).toBe(false);
    expect(isLoopbackHost('example.com')).toBe(false);
    expect(isLoopbackHost('my-remote-host')).toBe(false);
  });

  it('rejects near-loopback lookalikes that are not the exact allowlist', () => {
    // 故意收窄:整个 127.0.0.0/8 段、IPv4-mapped IPv6、以及空串都不算 loopback。
    expect(isLoopbackHost('127.0.0.2')).toBe(false);
    expect(isLoopbackHost('127.1.2.3')).toBe(false);
    expect(isLoopbackHost('::ffff:127.0.0.1')).toBe(false);
    expect(isLoopbackHost('')).toBe(false);
  });
});

describe('resolveListenHost', () => {
  it('allows loopback hosts regardless of the escape hatch', () => {
    for (const host of ['127.0.0.1', '::1', 'localhost']) {
      const allowed = resolveListenHost(host, false);
      expect(allowed).toEqual({ ok: true, host });
      // 逃生阀开着也不该给 loopback 加警告(它本就安全)。
      expect(resolveListenHost(host, true)).toEqual({ ok: true, host });
    }
  });

  it('normalizes surrounding whitespace and returns trimmed host', () => {
    // ok: true 时返回的 host 必须已 trim,可直接用于 server.listen()
    expect(resolveListenHost('  127.0.0.1  ', false)).toEqual({ ok: true, host: '127.0.0.1' });
    expect(resolveListenHost('  ::1\n', false)).toEqual({ ok: true, host: '::1' });
  });

  it('refuses non-loopback hosts by default (fail-closed)', () => {
    const result = resolveListenHost('0.0.0.0', false);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected refusal');
    expect(result.host).toBe('0.0.0.0');
    expect(result.error).toContain('0.0.0.0');
    expect(result.error).toContain(ALLOW_NON_LOOPBACK_ENV);
  });

  it('refuses public IPs and hostnames by default', () => {
    for (const host of ['192.168.1.10', '8.8.8.8', 'evil.example.com']) {
      const result = resolveListenHost(host, false);
      expect(result.ok).toBe(false);
    }
  });

  it('allows a non-loopback host with a warning when the escape hatch is set', () => {
    const result = resolveListenHost('0.0.0.0', true);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected allow');
    expect(result.host).toBe('0.0.0.0');
    expect(result.warning).toBeDefined();
    expect(result.warning).toContain('0.0.0.0');
    expect(result.warning).toContain(ALLOW_NON_LOOPBACK_ENV);
  });
});
