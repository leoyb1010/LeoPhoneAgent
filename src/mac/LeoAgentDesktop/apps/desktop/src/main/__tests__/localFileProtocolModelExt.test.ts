/**
 * localFileProtocolModelExt.test.ts
 * ---------------------------------------------------------------------------
 * The xdt-file:// whitelist gained glTF model extensions (.glb/.gltf) so the
 * in-app ModelLightbox (model-viewer fetch) can pull bytes for chat file-chip
 * previews. Guard both directions:
 *   - .glb/.gltf serve 200 with the right Content-Type
 *   - .fbx is deliberately NOT whitelisted (no in-app FBX preview — the chip
 *     reveals the file in Finder instead) and stays 415 like any other
 *     non-whitelisted binary (.exe)
 *
 * Mirrors the mock setup of localFileProtocolDoubleDecode.test.ts.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/never-used-here' },
  protocol: {
    registerSchemesAsPrivileged: vi.fn(),
    handle: vi.fn(),
  },
}));

vi.mock('node:fs/promises', () => ({
  stat: vi.fn(),
  readFile: vi.fn(),
  // Sandbox realpath (identity here): /tmp targets aren't inside any sensitive
  // root, so confinement is a no-op and prior behavior is preserved.
  realpath: vi.fn(async (p: string) => p),
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

const ABS_DIR = process.platform === 'win32' ? 'C:\\tmp\\' : '/tmp/';
function urlFor(filename: string): string {
  return `xdt-file://local/?path=${encodeURIComponent(ABS_DIR + filename)}`;
}

function mockExistingFile(content: string): void {
  (fs.stat as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
    isFile: () => true,
  });
  (fs.readFile as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(
    Buffer.from(content),
  );
}

describe('localFileProtocol — 3D model extensions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each([
    ['model.glb', 'model/gltf-binary'],
    ['scene.gltf', 'model/gltf+json'],
    // 大小写不敏感(ext 判定统一 toLowerCase)
    ['SCENE.GLB', 'model/gltf-binary'],
  ])('serves %s as 200 with %s', async (filename, mime) => {
    mockExistingFile('FAKE_MODEL_BYTES');
    const handler = getHandler();
    const res = await handler(new Request(urlFor(filename)));
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe(mime);
  });

  it.each([['character.fbx'], ['evil.exe']])(
    'rejects non-whitelisted %s with 415',
    async (filename) => {
      mockExistingFile('MZ');
      const handler = getHandler();
      const res = await handler(new Request(urlFor(filename)));
      expect(res.status).toBe(415);
    },
  );
});
