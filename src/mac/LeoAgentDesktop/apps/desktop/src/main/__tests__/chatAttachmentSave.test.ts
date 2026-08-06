import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import {
  createChatAttachmentSaveHandler,
  sanitizeAttachmentSaveName,
  type ChatAttachmentSaveDeps,
  type ChatAttachmentOpenedSource,
  type ChatAttachmentSourceStat,
} from '../chatAttachmentSave';

function fileStat(dev = 1n, ino = 1n): ChatAttachmentSourceStat {
  return { dev, ino, isFile: () => true };
}

function openedSource(
  overrides: Partial<ChatAttachmentOpenedSource> = {},
): ChatAttachmentOpenedSource {
  return {
    stat: vi.fn(async () => fileStat()),
    copyTo: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    ...overrides,
  };
}

function makeDeps(overrides: Partial<ChatAttachmentSaveDeps> = {}): ChatAttachmentSaveDeps {
  return {
    isPathAllowed: () => true,
    realpath: vi.fn(async (filePath) => filePath),
    stat: vi.fn(async () => fileStat()),
    openSource: vi.fn(async () => openedSource()),
    showSaveDialog: vi.fn(async ({ defaultPath }) => ({
      canceled: false,
      filePath: `${defaultPath}.saved`,
    })),
    getDownloadsDir: () => path.resolve('downloads'),
    getAllowedSourceRoots: () => [path.resolve('cache')],
    ...overrides,
  };
}

describe('sanitizeAttachmentSaveName', () => {
  it('keeps the original extension while removing path and platform hazards', () => {
    expect(sanitizeAttachmentSaveName('../../setup.exe')).toBe('setup.exe');
    expect(sanitizeAttachmentSaveName('a\\b/re:po|rt?.msi')).toBe('report.msi');
    expect(sanitizeAttachmentSaveName('NUL.exe')).toBe('_NUL.exe');
    expect(sanitizeAttachmentSaveName('.')).toBe('download.bin');
  });
});

describe('createChatAttachmentSaveHandler', () => {
  it('restores the sanitized original name for a .bin cache file without opening it', async () => {
    const source = openedSource();
    const deps = makeDeps({ openSource: vi.fn(async () => source) });
    const sourcePath = path.resolve('cache', 'random.bin');
    const result = await createChatAttachmentSaveHandler(deps)({
      sourcePath,
      suggestedName: '../../setup.exe',
    });

    const defaultPath = path.join(path.resolve('downloads'), 'setup.exe');
    expect(deps.showSaveDialog).toHaveBeenCalledWith({ defaultPath });
    expect(deps.openSource).toHaveBeenCalledWith(sourcePath);
    expect(source.copyTo).toHaveBeenCalledWith(`${defaultPath}.saved`);
    expect(source.close).toHaveBeenCalledOnce();
    expect(result).toEqual({ status: 'saved', savedPath: `${defaultPath}.saved` });
  });

  it('treats dialog cancellation as a no-op', async () => {
    const deps = makeDeps({ showSaveDialog: vi.fn(async () => ({ canceled: true })) });
    const result = await createChatAttachmentSaveHandler(deps)({
      sourcePath: path.resolve('cache', 'random.bin'),
      suggestedName: 'setup.exe',
    });
    expect(result).toEqual({ status: 'canceled' });
    expect(deps.openSource).not.toHaveBeenCalled();
  });

  it('rejects relative, forbidden, missing, and non-file sources before opening the dialog', async () => {
    const relative = makeDeps();
    await expect(
      createChatAttachmentSaveHandler(relative)({
        sourcePath: 'relative.bin',
        suggestedName: 'a.exe',
      }),
    ).resolves.toEqual({ status: 'error', code: 'invalid_source' });

    const forbidden = makeDeps({ isPathAllowed: () => false });
    await expect(
      createChatAttachmentSaveHandler(forbidden)({
        sourcePath: path.resolve('cache', 'a.bin'),
        suggestedName: 'a.exe',
      }),
    ).resolves.toEqual({ status: 'error', code: 'forbidden' });

    const missing = makeDeps({
      stat: vi.fn(async () => {
        const err = new Error('missing') as NodeJS.ErrnoException;
        err.code = 'ENOENT';
        throw err;
      }),
    });
    await expect(
      createChatAttachmentSaveHandler(missing)({
        sourcePath: path.resolve('cache', 'a.bin'),
        suggestedName: 'a.exe',
      }),
    ).resolves.toEqual({ status: 'error', code: 'not_found' });

    const directory = makeDeps({
      stat: vi.fn(async () => ({ ...fileStat(), isFile: () => false })),
    });
    await expect(
      createChatAttachmentSaveHandler(directory)({
        sourcePath: path.resolve('cache', 'folder'),
        suggestedName: 'a.exe',
      }),
    ).resolves.toEqual({ status: 'error', code: 'not_file' });

    expect(relative.showSaveDialog).not.toHaveBeenCalled();
    expect(forbidden.showSaveDialog).not.toHaveBeenCalled();
    expect(missing.showSaveDialog).not.toHaveBeenCalled();
    expect(directory.showSaveDialog).not.toHaveBeenCalled();
  });

  it('rejects direct out-of-cache paths and symlinks that resolve outside controlled caches', async () => {
    const cacheRoot = path.resolve('cache');
    const secretPath = path.resolve('secrets', 'id_rsa');
    const direct = makeDeps({ getAllowedSourceRoots: () => [cacheRoot] });
    await expect(
      createChatAttachmentSaveHandler(direct)({
        sourcePath: secretPath,
        suggestedName: 'id_rsa.exe',
      }),
    ).resolves.toEqual({ status: 'error', code: 'forbidden' });

    const symlinkPath = path.join(cacheRoot, 'attachment.bin');
    const symlink = makeDeps({
      getAllowedSourceRoots: () => [cacheRoot],
      realpath: vi.fn(async (filePath) => (filePath === symlinkPath ? secretPath : filePath)),
    });
    await expect(
      createChatAttachmentSaveHandler(symlink)({
        sourcePath: symlinkPath,
        suggestedName: 'setup.exe',
      }),
    ).resolves.toEqual({ status: 'error', code: 'forbidden' });

    expect(direct.stat).not.toHaveBeenCalled();
    expect(direct.showSaveDialog).not.toHaveBeenCalled();
    expect(symlink.stat).not.toHaveBeenCalled();
    expect(symlink.showSaveDialog).not.toHaveBeenCalled();
  });

  it('stats and copies the resolved source path inside a controlled cache', async () => {
    const cacheRoot = path.resolve('cache');
    const symlinkPath = path.join(cacheRoot, 'attachment.bin');
    const resolvedPath = path.join(cacheRoot, 'real-attachment.bin');
    const source = openedSource();
    const deps = makeDeps({
      getAllowedSourceRoots: () => [cacheRoot],
      realpath: vi.fn(async (filePath) => (filePath === symlinkPath ? resolvedPath : filePath)),
      openSource: vi.fn(async () => source),
    });

    const result = await createChatAttachmentSaveHandler(deps)({
      sourcePath: symlinkPath,
      suggestedName: 'setup.exe',
    });

    const targetPath = `${path.join(path.resolve('downloads'), 'setup.exe')}.saved`;
    expect(deps.stat).toHaveBeenCalledWith(resolvedPath);
    expect(deps.openSource).toHaveBeenCalledWith(resolvedPath);
    expect(source.copyTo).toHaveBeenCalledWith(targetPath);
    expect(result).toEqual({ status: 'saved', savedPath: targetPath });
  });

  it('rejects a source replaced after validation and never copies from the new file object', async () => {
    const replacement = openedSource({ stat: vi.fn(async () => fileStat(1n, 2n)) });
    const deps = makeDeps({
      stat: vi.fn(async () => fileStat(1n, 1n)),
      openSource: vi.fn(async () => replacement),
    });

    await expect(
      createChatAttachmentSaveHandler(deps)({
        sourcePath: path.resolve('cache', 'attachment.bin'),
        suggestedName: 'setup.exe',
      }),
    ).resolves.toEqual({ status: 'error', code: 'forbidden' });

    expect(replacement.copyTo).not.toHaveBeenCalled();
    expect(replacement.close).toHaveBeenCalledOnce();
  });

  it('reports dialog and copy failures without claiming a save', async () => {
    const dialogFailure = makeDeps({
      showSaveDialog: vi.fn(async () => {
        throw new Error('dialog failed');
      }),
    });
    await expect(
      createChatAttachmentSaveHandler(dialogFailure)({
        sourcePath: path.resolve('cache', 'a.bin'),
        suggestedName: 'a.exe',
      }),
    ).resolves.toEqual({ status: 'error', code: 'dialog_failed' });

    const copyFailureSource = openedSource({
      copyTo: vi.fn(async () => {
        throw new Error('EACCES');
      }),
    });
    const copyFailure = makeDeps({
      openSource: vi.fn(async () => copyFailureSource),
    });
    await expect(
      createChatAttachmentSaveHandler(copyFailure)({
        sourcePath: path.resolve('cache', 'a.bin'),
        suggestedName: 'a.exe',
      }),
    ).resolves.toEqual({ status: 'error', code: 'copy_failed' });
    expect(copyFailureSource.close).toHaveBeenCalledOnce();
  });
});
