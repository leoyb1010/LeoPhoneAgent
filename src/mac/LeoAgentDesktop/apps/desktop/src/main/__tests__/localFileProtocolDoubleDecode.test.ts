/**
 * localFileProtocolDoubleDecode.test.ts
 * ---------------------------------------------------------------------------
 * Regression: the xdt-file:// handler used to call decodeURIComponent() on a
 * value already decoded by URLSearchParams.get(), which threw URIError → 500
 * for any filename containing a literal `%` (e.g. "100% done.png").
 *
 * Mirrors the test setup of audioFileProtocolRange.test.ts (electron + fs
 * mocked, handler captured from protocol.handle).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Readable } from 'node:stream';

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/never-used-here' },
  protocol: {
    registerSchemesAsPrivileged: vi.fn(),
    handle: vi.fn(),
  },
}));

vi.mock('node:fs/promises', () => ({
  stat: vi.fn(),
  // Sandbox realpath (identity): /tmp targets aren't inside any sensitive
  // root, so confinement is a no-op and the % / double-decode behavior under
  // test is unchanged.
  realpath: vi.fn(async (p: string) => p),
}));

// handler 的 body 走 node:fs createReadStream 流式(不再 readFile 整读)。
vi.mock('node:fs', () => ({
  createReadStream: vi.fn(() => Readable.from([Buffer.from('FAKE_PNG')])),
  // buildSensitiveMediaBlocklist realpath's existing roots; identity keeps the
  // roots verbatim without touching a real filesystem.
  realpathSync: { native: (p: string) => p },
}));

const fs = await import('node:fs/promises');
const electron = await import('electron');
const { registerLocalFileProtocolHandler } = await import(
  '../localFileProtocol'
);

function getHandler(): (req: Request) => Promise<Response> {
  const handle = electron.protocol.handle as unknown as ReturnType<typeof vi.fn>;
  registerLocalFileProtocolHandler();
  const lastCall = handle.mock.calls[handle.mock.calls.length - 1];
  return lastCall[1] as (req: Request) => Promise<Response>;
}

function makeRequest(url: string): Request {
  return new Request(url);
}

// path.resolve / path.normalize agree only on platform-native absolute paths,
// and the handler enforces that equality. Use a Windows-style path on win32
// and a POSIX path elsewhere so the test isn't tripped by that check.
const ABS_DIR = process.platform === 'win32' ? 'C:\\tmp\\' : '/tmp/';
function urlFor(filename: string): string {
  return `xdt-file://local/?path=${encodeURIComponent(ABS_DIR + filename)}`;
}

describe('localFileProtocol — no double-decode regression', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('serves filename containing a literal % as 200 (not 500)', async () => {
    // URLSearchParams.get already percent-decodes; a second
    // decodeURIComponent on "100% done.png" sees `% d` as an invalid escape
    // and throws URIError, which used to surface as 500.
    (fs.stat as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      isFile: () => true,
      size: 8,
    });
    const handler = getHandler();
    const res = await handler(makeRequest(urlFor('100% done.png')));
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('image/png');
  });

  it('still serves a vanilla path (sanity baseline)', async () => {
    (fs.stat as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      isFile: () => true,
      size: 8,
    });
    const handler = getHandler();
    const res = await handler(makeRequest(urlFor('img.png')));
    expect(res.status).toBe(200);
  });

  it('ignores a cache-busting revision query and serves the original path', async () => {
    (fs.stat as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      isFile: () => true,
      size: 8,
    });
    const handler = getHandler();
    const res = await handler(makeRequest(`${urlFor('img.png')}&v=12%3A34.5`));

    expect(res.status).toBe(200);
    expect(fs.realpath).toHaveBeenCalledWith(`${ABS_DIR}img.png`);
  });
});
