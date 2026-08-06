import { describe, expect, it } from 'vitest';
import {
  buildMobileSelectedFilePanel,
  buildMobileDirectoryEntries,
  buildMobilePathCrumbs,
  filePreviewSubtitle,
  formatFilePreviewStatus,
  summarizeMobileDirectoryEntries,
} from '@/session/fileBrowser';

describe('fileBrowser', () => {
  it('builds sorted directory and file rows for the mobile read-only file page', () => {
    const rows = buildMobileDirectoryEntries([
      { kind: 'dir', name: 'src', path: '/repo/src' },
      { kind: 'symlink', name: 'linked', path: '/repo/linked' },
      { kind: 'file', name: 'demo.mp4', path: '/repo/demo.mp4' },
    ], [
      { kind: 'file', resolvedPath: '/repo/README.md' },
      { kind: 'file', resolvedPath: '/repo/spec.pdf' },
      { kind: 'missing', resolvedPath: '/repo/missing.txt' },
    ]);

    expect(rows.map((row) => [row.kind, row.name, row.subtitle])).toEqual([
      ['symlink', 'linked', '目录链接'],
      ['dir', 'src', '目录'],
      ['file', 'demo.mp4', '二进制文件'],
      ['file', 'README.md', '文本预览'],
      ['file', 'spec.pdf', 'PDF'],
    ]);
  });

  it('builds path crumbs for absolute and home paths', () => {
    expect(buildMobilePathCrumbs('/Users/alice/Code')).toEqual([
      { label: '/', path: '/' },
      { label: 'Users', path: '/Users' },
      { label: 'alice', path: '/Users/alice' },
      { label: 'Code', path: '/Users/alice/Code' },
    ]);
    expect(buildMobilePathCrumbs('~/Code/xdt-maker')).toEqual([
      { label: '~', path: '~' },
      { label: 'Code', path: '~/Code' },
      { label: 'xdt-maker', path: '~/Code/xdt-maker' },
    ]);
  });

  it('summarizes directory rows for the mobile file page header', () => {
    const rows = buildMobileDirectoryEntries([
      { kind: 'dir', name: 'src', path: '/repo/src' },
      { kind: 'symlink', name: 'linked', path: '/repo/linked' },
      { kind: 'file', name: 'README.md', path: '/repo/README.md' },
    ]);

    expect(summarizeMobileDirectoryEntries(rows)).toEqual({
      directoryCount: 2,
      fileCount: 1,
      label: '2 个目录 · 1 个文件',
    });
    expect(summarizeMobileDirectoryEntries([])).toEqual({
      directoryCount: 0,
      fileCount: 0,
      label: '当前目录为空',
    });
  });

  it('formats preview subtitles and delegates status text to the file preview model', () => {
    expect(filePreviewSubtitle('drawio')).toBe('Draw.io');
    expect(formatFilePreviewStatus({ status: 'idle' }, true, 'text')).toContain('按需读取远程文本预览');
    expect(formatFilePreviewStatus({ status: 'idle' }, false, 'pdf')).toContain('PDF 文件暂不在手机版内嵌预览');
  });

  it('builds a mobile selected-file action panel', () => {
    expect(buildMobileSelectedFilePanel('', { status: 'idle' }, false, null)).toMatchObject({
      selected: false,
      title: '还没有选择文件',
      canLoadPreview: false,
      previewButtonDisabled: true,
    });

    expect(buildMobileSelectedFilePanel('/repo/README.md', { status: 'idle' }, false, '已复制路径')).toMatchObject({
      selected: true,
      title: 'README.md',
      kindLabel: '文本预览',
      copyStatus: '已复制路径',
      canLoadPreview: true,
      previewButtonLabel: '加载文本预览',
      previewButtonDisabled: false,
    });

    expect(buildMobileSelectedFilePanel('/repo/spec.pdf', { status: 'idle' }, false, null)).toMatchObject({
      selected: true,
      kindLabel: 'PDF',
      canLoadPreview: false,
    });

    expect(buildMobileSelectedFilePanel('/repo/README.md', { status: 'loading' }, true, null)).toMatchObject({
      canLoadPreview: true,
      previewButtonLabel: '加载中',
      previewButtonDisabled: true,
    });
  });
});
