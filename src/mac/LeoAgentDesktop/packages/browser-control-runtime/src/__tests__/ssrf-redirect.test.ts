import http from 'node:http';

import { afterEach, describe, expect, it } from 'vitest';

import { fetchWithSsrFGuard, isSameRedirectOrigin } from '../shim/ssrf-runtime.js';

/**
 * Regression net for the redirect-following logic in the OUR-code SSRF fetch shell
 * (shim/ssrf-runtime.ts) — the part most likely to silently regress on a vendored
 * re-sync. These run against real loopback HTTP servers; loopback is a private IP,
 * so the origin must be explicitly allowed via the policy (same shape the CDP
 * control-plane uses). Each hop still re-runs the vendored `guardHop`, so a
 * redirect to a blocked target is re-guarded — that per-hop block is covered by
 * the single-hop tests in ssrf-guard.test.ts; here we lock the shell's
 * follow / header-stripping / cap behavior.
 */
const POLICY = { allowedHostnames: ['127.0.0.1'], dangerouslyAllowPrivateNetwork: true };

// `listen(0)` may return a Fetch-standard blocked port (for example 6000).
// Undici rejects such URLs before connecting, which makes these real-server tests
// flaky even though the SSRF behavior under test is unrelated to the port number.
const FETCH_BLOCKED_PORTS = new Set([
  1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79, 87,
  95, 101, 102, 103, 104, 109, 110, 111, 113, 115, 117, 119, 123, 135, 137, 139, 143,
  161, 179, 389, 427, 465, 512, 513, 514, 515, 526, 530, 531, 532, 540, 548, 554, 556,
  563, 587, 601, 636, 989, 990, 993, 995, 1719, 1720, 1723, 2049, 3659, 4045, 4190,
  5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669, 6679, 6697, 10080,
]);

const openServers: http.Server[] = [];
function startServer(handler: http.RequestListener): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = http.createServer(handler);
    const listen = (): void => {
      const onError = (error: Error): void => reject(error);
      server.once('error', onError);
      server.listen(0, '127.0.0.1', () => {
        server.off('error', onError);
        const addr = server.address();
        const port = typeof addr === 'object' && addr ? addr.port : 0;
        if (FETCH_BLOCKED_PORTS.has(port)) {
          server.close(listen);
          return;
        }
        openServers.push(server);
        resolve(port);
      });
    };
    listen();
  });
}

afterEach(async () => {
  await Promise.all(openServers.splice(0).map((s) => new Promise<void>((r) => s.close(() => r()))));
});

describe('fetchWithSsrFGuard redirect handling', () => {
  it('strips Authorization/Cookie on a cross-origin redirect', async () => {
    let received: http.IncomingHttpHeaders | undefined;
    const recvPort = await startServer((req, res) => {
      received = req.headers;
      res.writeHead(200).end('ok');
    });
    const redirPort = await startServer((_req, res) => {
      res.writeHead(302, { location: `http://127.0.0.1:${recvPort}/recv` }).end();
    });

    const { release } = await fetchWithSsrFGuard({
      url: `http://127.0.0.1:${redirPort}/start`,
      init: { headers: { authorization: 'Bearer secret', cookie: 'sid=abc', 'x-openclaw-password': 'pw' } },
      policy: POLICY,
    });
    await release();

    // Different host:port ⇒ sensitive headers must not leak to the new origin —
    // including the browser-control loopback auth header.
    expect(received?.authorization).toBeUndefined();
    expect(received?.cookie).toBeUndefined();
    expect(received?.['x-openclaw-password']).toBeUndefined();
  });

  it('keeps Authorization on a same-origin redirect', async () => {
    let received: http.IncomingHttpHeaders | undefined;
    let port = 0;
    port = await startServer((req, res) => {
      if (req.url === '/start') {
        res.writeHead(302, { location: `http://127.0.0.1:${port}/recv` }).end();
        return;
      }
      received = req.headers;
      res.writeHead(200).end('ok');
    });

    const { release } = await fetchWithSsrFGuard({
      url: `http://127.0.0.1:${port}/start`,
      init: { headers: { authorization: 'Bearer secret' } },
      policy: POLICY,
    });
    await release();

    expect(received?.authorization).toBe('Bearer secret');
  });

  it('throws after exceeding maxRedirects', async () => {
    let port = 0;
    port = await startServer((_req, res) => {
      res.writeHead(302, { location: `http://127.0.0.1:${port}/loop` }).end();
    });

    await expect(
      fetchWithSsrFGuard({ url: `http://127.0.0.1:${port}/`, policy: POLICY, maxRedirects: 2 }),
    ).rejects.toThrow(/too many redirects/i);
  });
});

describe('isSameRedirectOrigin (credential-preservation gate)', () => {
  const u = (s: string) => new URL(s);
  it('keeps credentials only for an identical origin', () => {
    expect(isSameRedirectOrigin(u('https://x.com/a'), u('https://x.com/b'))).toBe(true);
  });
  it('strips on an https→http scheme downgrade to the same host:port (cleartext leak)', () => {
    // host:port match but scheme differs — the bug a host-only compare missed.
    expect(isSameRedirectOrigin(u('https://x.com:443/a'), u('http://x.com:443/a'))).toBe(false);
    expect(isSameRedirectOrigin(u('https://x.com/a'), u('http://x.com/a'))).toBe(false);
  });
  it('strips on a different port or host', () => {
    expect(isSameRedirectOrigin(u('https://x.com/a'), u('https://x.com:8443/a'))).toBe(false);
    expect(isSameRedirectOrigin(u('https://x.com/a'), u('https://y.com/a'))).toBe(false);
  });
});
