import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../folderHash', () => ({
  computeFolderHash: vi.fn(),
}));

vi.mock('../../logger', () => ({
  createLogger: () => ({
    warn: vi.fn(),
  }),
}));

vi.mock('../registry', () => ({
  registryService: {
    getInstall: vi.fn(),
    updateInstall: vi.fn(),
    addInstall: vi.fn(),
  },
}));

import { computeFolderHash } from '../folderHash';
import { registryService } from '../registry';
import { reconcileMineRegistry } from '../reconcileMineRegistry';
import type { StoredInstall } from '../registry/types';

function makeInstall(overrides: Partial<StoredInstall> = {}): StoredInstall {
  return {
    version: '1.0.0',
    authorId: 'team-old',
    folderHash: 'old-hash',
    installedAt: 1714000000,
    updatedAt: 1714000000,
    origin: 'published',
    ...overrides,
  };
}

describe('reconcileMineRegistry', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(computeFolderHash).mockResolvedValue('current-folder-hash');
  });

  it('does not overwrite an existing registry version with server latestVersion', async () => {
    vi.mocked(registryService.getInstall).mockResolvedValue(makeInstall({ version: '1.0.0' }));

    const result = await reconcileMineRegistry([
      {
        name: 'my-skill',
        absolutePath: '/Users/me/.agents/skills/my-skill',
        version: '1.0.1',
        authorId: 'team-old',
      },
    ]);

    expect(result).toEqual({ success: true, added: 0, flipped: 0, failures: [] });
    expect(registryService.updateInstall).not.toHaveBeenCalled();
  });

  it('repairs ownership metadata on existing registry entries without changing version', async () => {
    vi.mocked(registryService.getInstall).mockResolvedValue(
      makeInstall({ version: '1.0.0', authorId: '', origin: undefined }),
    );

    const result = await reconcileMineRegistry([
      {
        name: 'my-skill',
        absolutePath: '/Users/me/.agents/skills/my-skill',
        version: '1.0.1',
        authorId: 'team-new',
      },
    ]);

    expect(result).toEqual({ success: true, added: 0, flipped: 1, failures: [] });
    expect(registryService.updateInstall).toHaveBeenCalledWith(
      'my-skill',
      '/Users/me/.agents/skills/my-skill',
      expect.objectContaining({
        authorId: 'team-new',
        origin: 'published',
      }),
    );
    expect(registryService.updateInstall).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ version: expect.anything() }),
    );
  });

  it('creates a missing legacy registry entry using server folderHash as the initial baseline when available', async () => {
    vi.mocked(registryService.getInstall).mockResolvedValue(null);

    const result = await reconcileMineRegistry([
      {
        name: 'my-skill',
        absolutePath: '/Users/me/.agents/skills/my-skill',
        version: '1.0.1',
        authorId: 'team-new',
        folderHash: 'server-folder-hash',
      },
    ]);

    expect(result).toEqual({ success: true, added: 1, flipped: 0, failures: [] });
    expect(registryService.addInstall).toHaveBeenCalledWith(
      'my-skill',
      '/Users/me/.agents/skills/my-skill',
      expect.objectContaining({
        version: '1.0.1',
        authorId: 'team-new',
        folderHash: 'server-folder-hash',
        origin: 'published',
      }),
    );
    expect(computeFolderHash).not.toHaveBeenCalled();
  });

  it('falls back to local folderHash when server folderHash is unavailable', async () => {
    vi.mocked(registryService.getInstall).mockResolvedValue(null);

    const result = await reconcileMineRegistry([
      {
        name: 'my-skill',
        absolutePath: '/Users/me/.agents/skills/my-skill',
        version: '1.0.1',
        authorId: 'team-new',
      },
    ]);

    expect(result).toEqual({ success: true, added: 1, flipped: 0, failures: [] });
    expect(registryService.addInstall).toHaveBeenCalledWith(
      'my-skill',
      '/Users/me/.agents/skills/my-skill',
      expect.objectContaining({
        version: '1.0.1',
        authorId: 'team-new',
        folderHash: 'current-folder-hash',
        origin: 'published',
      }),
    );
  });
});
