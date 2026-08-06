import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  appMock,
  createBinaryProvisioner,
  findCachedLinuxRuntimeFallbackBinary,
  prepareLinuxRuntimeFallback,
} = vi.hoisted(() => ({
  appMock: { isPackaged: true, getPath: vi.fn(() => '/tmp/xdt-userdata') },
  createBinaryProvisioner: vi.fn(),
  findCachedLinuxRuntimeFallbackBinary: vi.fn((): string | null => null),
  prepareLinuxRuntimeFallback: vi.fn(),
}));

vi.mock('electron', () => ({
  app: appMock,
  BrowserWindow: { getAllWindows: () => [] },
}));
vi.mock('../agent-binaries/factory.js', () => ({ createBinaryProvisioner }));
vi.mock('../agent-binaries/dev-fallback.js', () => ({ findDevBinary: vi.fn(() => null) }));
vi.mock('../agent-binaries/linux-runtime-fallback.js', () => ({
  findCachedLinuxRuntimeFallbackBinary,
  prepareLinuxRuntimeFallback,
}));
vi.mock('../manifestService.js', () => ({ getPlatformKey: () => 'linux-x64' }));
vi.mock('../updateProgressNormalizer.js', () => ({
  ProgressNormalizer: class {
    handle(): void {}
    flush(): void {}
    getCurrent(): number { return 0; }
  },
}));

const originalPlatform = process.platform;
let binaries: typeof import('../agent-binaries/index');

beforeAll(async () => {
  Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
  binaries = await import('../agent-binaries/index');
});

beforeEach(() => {
  vi.clearAllMocks();
  appMock.isPackaged = true;
  findCachedLinuxRuntimeFallbackBinary.mockReturnValue(null);
  prepareLinuxRuntimeFallback.mockResolvedValue({
    ready: true,
    binaryPath: '/tmp/xdt-userdata/agent-runtime/claude-code/bin/claude',
    installed: true,
    source: 'installed',
  });
});

describe('packaged Linux agent binary prepare', () => {
  it('keeps cached status fs-only and does not run runtime verification', () => {
    findCachedLinuxRuntimeFallbackBinary.mockReturnValue(
      '/tmp/xdt-userdata/agent-runtime/codex/codex-home/bin/codex',
    );

    expect(binaries.getCachedBinaryStatus('codex')).toEqual({
      binaryReady: true,
      binaryPath: '/tmp/xdt-userdata/agent-runtime/codex/codex-home/bin/codex',
    });
    expect(findCachedLinuxRuntimeFallbackBinary).toHaveBeenCalledWith('codex');
  });

  it('reuses an existing runtime binary without private install or CDN work', async () => {
    prepareLinuxRuntimeFallback.mockResolvedValueOnce({
      ready: true,
      binaryPath: '/usr/local/bin/claude',
      installed: false,
      source: 'system',
    });

    const result = await binaries.prepare('claude-code');

    expect(result).toEqual({
      ready: true,
      path: '/usr/local/bin/claude',
      downloaded: false,
    });
    expect(prepareLinuxRuntimeFallback).toHaveBeenCalledWith('claude-code', {
      signal: undefined,
      onProgress: expect.any(Function),
    });
    expect(createBinaryProvisioner).not.toHaveBeenCalled();
  });

  it('goes directly to the runtime fallback without creating or probing the CDN provisioner', async () => {
    const controller = new AbortController();
    const result = await binaries.prepare('claude-code');

    expect(result).toEqual({
      ready: true,
      path: '/tmp/xdt-userdata/agent-runtime/claude-code/bin/claude',
      downloaded: true,
    });
    await binaries.prepare('codex', { signal: controller.signal });
    expect(prepareLinuxRuntimeFallback).toHaveBeenNthCalledWith(1, 'claude-code', {
      signal: undefined,
      onProgress: expect.any(Function),
    });
    expect(prepareLinuxRuntimeFallback).toHaveBeenNthCalledWith(2, 'codex', {
      signal: controller.signal,
      onProgress: expect.any(Function),
    });
    expect(createBinaryProvisioner).not.toHaveBeenCalled();
  });

  it('reports a local miss as a private install need without fetching a manifest', async () => {
    await expect(binaries.peekNeedsDownload('codex')).resolves.toBe(true);
    expect(findCachedLinuxRuntimeFallbackBinary).toHaveBeenCalledWith('codex');
    expect(createBinaryProvisioner).not.toHaveBeenCalled();
  });
});

afterAll(() => {
  Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
});
