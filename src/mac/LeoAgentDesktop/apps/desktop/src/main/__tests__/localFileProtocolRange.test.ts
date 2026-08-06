/**
 * localFileProtocolRange.test.ts
 * ---------------------------------------------------------------------------
 * Locks in the xdt-file:// handler's video-extension whitelist and the
 * streaming Range pipeline added for remote-file-cache 大文件预览(2GB 视频
 * 副本不能整文件进内存,body 一律 createReadStream 流式;<video> 拖进度条
 * 依赖 206 Range)。
 *
 * Parser 语义(对齐 audioFileProtocol 的三态):
 *   null → 无 / 非法 Range → 200 全量;unsatisfiable → 416;range → 206。
 *   end 越界按 RFC 7233 收窄而非判非法(与 audio 有意不同,大文件下探针
 *   range 常写超)。
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
  // root, so confinement is a no-op and the streaming behavior under test is
  // unchanged.
  realpath: vi.fn(async (p: string) => p),
}));

// streamBody 走 node:fs createReadStream;测试里用固定 10 字节内容按
// start/end 切片喂回,断言 206 的 body 字节正确。
const FILE_BYTES = Buffer.from('0123456789');
vi.mock('node:fs', () => ({
  createReadStream: vi.fn((_p: string, opts?: { start: number; end: number }) => {
    const slice = opts ? FILE_BYTES.subarray(opts.start, opts.end + 1) : FILE_BYTES;
    return Readable.from([Buffer.from(slice)]);
  }),
  // buildSensitiveMediaBlocklist realpath's existing roots; identity keeps the
  // roots verbatim without touching a real filesystem.
  realpathSync: { native: (p: string) => p },
}));

const fs = await import('node:fs/promises');
const electron = await import('electron');
const { parseRangeHeader, registerLocalFileProtocolHandler } = await import(
  '../localFileProtocol'
);

describe('localFileProtocol parseRangeHeader', () => {
  it('returns null when header is absent', () => {
    expect(parseRangeHeader(null, 1000)).toBeNull();
  });

  it('parses bytes=0- (chromium <video> initial fetch) → full file range', () => {
    expect(parseRangeHeader('bytes=0-', 1000)).toEqual({ kind: 'range', start: 0, end: 999 });
  });

  it('parses an explicit closed range', () => {
    expect(parseRangeHeader('bytes=100-199', 1000)).toEqual({
      kind: 'range',
      start: 100,
      end: 199,
    });
  });

  it('parses a suffix range (last N bytes)', () => {
    expect(parseRangeHeader('bytes=-256', 1000)).toEqual({ kind: 'range', start: 744, end: 999 });
  });

  it('clamps an over-long end to size-1 (RFC 7233) instead of rejecting', () => {
    expect(parseRangeHeader('bytes=0-9999', 1000)).toEqual({ kind: 'range', start: 0, end: 999 });
  });

  it('classifies out-of-range start / inverted range as unsatisfiable', () => {
    expect(parseRangeHeader('bytes=2000-', 1000)).toEqual({ kind: 'unsatisfiable' });
    expect(parseRangeHeader('bytes=500-100', 1000)).toEqual({ kind: 'unsatisfiable' });
  });

  it('returns null for malformed header (caller falls back to 200)', () => {
    expect(parseRangeHeader('blocks=0-100', 1000)).toBeNull();
    expect(parseRangeHeader('bytes=abc', 1000)).toBeNull();
    expect(parseRangeHeader('', 1000)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Handler tests — capture the fn passed to protocol.handle and invoke with
// synthetic Requests; fs.stat / createReadStream mocked.
// ---------------------------------------------------------------------------

function getHandler(): (req: Request) => Promise<Response> {
  const handle = electron.protocol.handle as unknown as ReturnType<typeof vi.fn>;
  registerLocalFileProtocolHandler();
  const lastCall = handle.mock.calls[handle.mock.calls.length - 1];
  return lastCall[1] as (req: Request) => Promise<Response>;
}

// path.resolve / path.normalize agree only on platform-native absolute paths,
// and the handler enforces that equality (same trick as the double-decode test).
const ABS_DIR = process.platform === 'win32' ? 'C:\\tmp\\' : '/tmp/';
function urlFor(filename: string): string {
  return `xdt-file://local/?path=${encodeURIComponent(ABS_DIR + filename)}`;
}

describe('localFileProtocol handler — video whitelist + range streaming', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (fs.stat as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      isFile: () => true,
      size: FILE_BYTES.length,
    });
  });

  it('serves .mp4 as 200 video/mp4 with Accept-Ranges (was 415 before)', async () => {
    const handler = getHandler();
    const res = await handler(new Request(urlFor('clip.mp4')));
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('video/mp4');
    expect(res.headers.get('Content-Length')).toBe('10');
    expect(res.headers.get('Accept-Ranges')).toBe('bytes');
    expect(Buffer.from(await res.arrayBuffer()).toString()).toBe('0123456789');
  });

  it('serves .webm / .mov / .m4v with correct mime', async () => {
    const handler = getHandler();
    expect((await handler(new Request(urlFor('a.webm')))).headers.get('Content-Type')).toBe(
      'video/webm',
    );
    expect((await handler(new Request(urlFor('b.mov')))).headers.get('Content-Type')).toBe(
      'video/quicktime',
    );
    expect((await handler(new Request(urlFor('c.m4v')))).headers.get('Content-Type')).toBe(
      'video/mp4',
    );
  });

  it('still rejects non-whitelisted extension with 415', async () => {
    const handler = getHandler();
    expect((await handler(new Request(urlFor('evil.exe')))).status).toBe(415);
    expect((await handler(new Request(urlFor('notes.txt')))).status).toBe(415);
  });

  it('serves a closed range as 206 with sliced bytes + headers', async () => {
    const handler = getHandler();
    const res = await handler(
      new Request(urlFor('clip.mp4'), { headers: { Range: 'bytes=2-5' } }),
    );
    expect(res.status).toBe(206);
    expect(res.headers.get('Content-Range')).toBe('bytes 2-5/10');
    expect(res.headers.get('Content-Length')).toBe('4');
    expect(res.headers.get('Accept-Ranges')).toBe('bytes');
    expect(Buffer.from(await res.arrayBuffer()).toString()).toBe('2345');
  });

  it('maps an unsatisfiable range to 416 with full media headers', async () => {
    const handler = getHandler();
    const res = await handler(
      new Request(urlFor('clip.mp4'), { headers: { Range: 'bytes=999-' } }),
    );
    expect(res.status).toBe(416);
    expect(res.headers.get('Content-Range')).toBe('bytes */10');
    expect(res.headers.get('Content-Type')).toBe('video/mp4');
  });

  it('falls back to 200 full body on malformed Range header', async () => {
    const handler = getHandler();
    const res = await handler(
      new Request(urlFor('clip.mp4'), { headers: { Range: 'blocks=0-3' } }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Length')).toBe('10');
  });

  it('images stream too (no whole-file readFile) and keep prior mime behavior', async () => {
    const handler = getHandler();
    const res = await handler(new Request(urlFor('img.png')));
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('image/png');
    expect(Buffer.from(await res.arrayBuffer()).toString()).toBe('0123456789');
  });

  it('serves an empty file as 200 with Content-Length 0 and no stream', async () => {
    (fs.stat as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      isFile: () => true,
      size: 0,
    });
    const handler = getHandler();
    const res = await handler(new Request(urlFor('empty.png')));
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Length')).toBe('0');
  });
});
