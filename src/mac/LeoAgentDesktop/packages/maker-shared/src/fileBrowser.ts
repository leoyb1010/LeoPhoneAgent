import {
  basenameRemotePath,
  remoteFilePreviewKind,
  textPreviewStatusText,
  type RemoteFilePreviewKind,
  type TextFilePreviewState,
} from './filePreview';

export interface RemoteDirectoryEntryLike {
  name: string;
  kind: 'dir' | 'symlink' | 'file';
  path: string;
}

export interface RemotePathStatResultLike {
  kind: 'dir' | 'file' | 'missing';
  resolvedPath: string;
}

export interface RemoteDirectoryListResultLike {
  resolvedPath: string;
  entries: RemoteDirectoryEntryLike[];
  parent: string | null;
}

export interface MobileFileBrowserEntry {
  key: string;
  name: string;
  path: string;
  kind: 'dir' | 'file' | 'symlink';
  subtitle: string;
  previewKind?: RemoteFilePreviewKind;
}

export interface MobileFilePathCrumb {
  label: string;
  path: string;
}

export interface MobileDirectorySummary {
  directoryCount: number;
  fileCount: number;
  label: string;
}

export interface MobileSelectedFilePanel {
  selected: boolean;
  title: string;
  kindLabel: string;
  path: string;
  statusText: string;
  copyStatus: string | null;
  canLoadPreview: boolean;
  previewButtonLabel: string;
  previewButtonDisabled: boolean;
}

export function normalizeRemoteDirectoryListResult(value: unknown): RemoteDirectoryListResultLike {
  if (!isRecord(value)) {
    return { resolvedPath: '', entries: [], parent: null };
  }
  return {
    resolvedPath: readString(value, 'resolvedPath') ?? '',
    entries: normalizeRemoteDirectoryEntries(value.entries),
    parent: readString(value, 'parent'),
  };
}

export function normalizeRemoteDirectoryEntries(value: unknown): RemoteDirectoryEntryLike[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter(isRecord)
    .map((entry) => {
      const path = readString(entry, 'path') ?? readString(entry, 'resolvedPath') ?? readString(entry, 'relPath');
      if (!path) return null;
      const kind = normalizeEntryKind(entry.kind ?? entry.type);
      if (!kind) return null;
      const fallbackName = basenameRemotePath(path) || path;
      const name = readString(entry, 'name') ?? fallbackName;
      return {
        name,
        kind,
        path,
      };
    })
    .filter((entry): entry is RemoteDirectoryEntryLike => !!entry);
}

export function normalizeRemotePathStatResults(value: unknown): RemotePathStatResultLike[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter(isRecord)
    .map((entry) => {
      const resolvedPath = readString(entry, 'resolvedPath') ?? readString(entry, 'path') ?? readString(entry, 'relPath');
      if (!resolvedPath) return null;
      const kind = normalizeStatKind(entry.kind ?? entry.type);
      if (!kind) return null;
      return { kind, resolvedPath };
    })
    .filter((entry): entry is RemotePathStatResultLike => !!entry);
}

export function buildMobileDirectoryEntries(
  dirs: readonly RemoteDirectoryEntryLike[],
  files: readonly RemotePathStatResultLike[] = [],
): MobileFileBrowserEntry[] {
  const directoryEntries = dirs.map((entry): MobileFileBrowserEntry => {
    if (entry.kind === 'file') {
      const previewKind = remoteFilePreviewKind(entry.path);
      return {
        key: `file:${entry.path}`,
        name: entry.name || basenameRemotePath(entry.path) || entry.path,
        path: entry.path,
        kind: 'file',
        previewKind,
        subtitle: filePreviewSubtitle(previewKind),
      };
    }
    return {
      key: `dir:${entry.path}`,
      name: entry.name || basenameRemotePath(entry.path) || entry.path,
      path: entry.path,
      kind: entry.kind,
      subtitle: entry.kind === 'symlink' ? '目录链接' : '目录',
    };
  });
  const fileEntries = files
    .filter((file) => file.kind === 'file')
    .map((file): MobileFileBrowserEntry => {
      const previewKind = remoteFilePreviewKind(file.resolvedPath);
      return {
        key: `file:${file.resolvedPath}`,
        name: basenameRemotePath(file.resolvedPath) || file.resolvedPath,
        path: file.resolvedPath,
        kind: 'file',
        previewKind,
        subtitle: filePreviewSubtitle(previewKind),
      };
    });

  return [...directoryEntries, ...fileEntries].sort(compareFileBrowserEntries);
}

export function buildMobilePathCrumbs(path: string): MobileFilePathCrumb[] {
  const trimmed = path.trim();
  if (!trimmed) return [];
  if (trimmed === '~') return [{ label: '~', path: '~' }];

  const isHome = trimmed.startsWith('~/');
  const rawParts = trimmed.split('/').filter(Boolean);
  if (trimmed.startsWith('/') && rawParts.length === 0) return [{ label: '/', path: '/' }];

  const crumbs: MobileFilePathCrumb[] = [];
  if (trimmed.startsWith('/')) {
    crumbs.push({ label: '/', path: '/' });
  } else if (isHome) {
    crumbs.push({ label: '~', path: '~' });
  }

  let current = trimmed.startsWith('/') ? '/' : isHome ? '~' : '';
  const parts = isHome ? rawParts.slice(1) : rawParts;
  for (const part of parts) {
    current = current === '' ? part : current === '/' ? `/${part}` : `${current}/${part}`;
    crumbs.push({ label: part, path: current });
  }
  return crumbs.length > 0 ? crumbs : [{ label: trimmed, path: trimmed }];
}

export function summarizeMobileDirectoryEntries(entries: readonly MobileFileBrowserEntry[]): MobileDirectorySummary {
  const directoryCount = entries.filter((entry) => entry.kind !== 'file').length;
  const fileCount = entries.length - directoryCount;
  const label = [
    directoryCount > 0 ? `${directoryCount} 个目录` : null,
    fileCount > 0 ? `${fileCount} 个文件` : null,
  ].filter(Boolean).join(' · ') || '当前目录为空';

  return { directoryCount, fileCount, label };
}

export function filePreviewSubtitle(kind: RemoteFilePreviewKind): string {
  if (kind === 'text') return '文本预览';
  if (kind === 'pdf') return 'PDF';
  if (kind === 'drawio') return 'Draw.io';
  if (kind === 'office') return 'Office';
  if (kind === 'binary') return '二进制文件';
  return '文件';
}

export function formatFilePreviewStatus(
  state: TextFilePreviewState,
  canPreview: boolean,
  kind: RemoteFilePreviewKind,
): string {
  return textPreviewStatusText(state, canPreview, kind);
}

export function buildMobileSelectedFilePanel(
  path: string,
  state: TextFilePreviewState,
  previewLoading: boolean,
  copyStatus: string | null,
): MobileSelectedFilePanel {
  const trimmed = path.trim();
  if (!trimmed) {
    return {
      selected: false,
      title: '还没有选择文件',
      kindLabel: '未选择',
      path: '',
      statusText: '点目录里的文件,或在上方输入完整文件路径。',
      copyStatus: null,
      canLoadPreview: false,
      previewButtonLabel: '加载文本预览',
      previewButtonDisabled: true,
    };
  }

  const kind = remoteFilePreviewKind(trimmed);
  const canPreview = kind === 'text';
  const loading = previewLoading || state.status === 'loading';
  return {
    selected: true,
    title: basenameRemotePath(trimmed) || trimmed,
    kindLabel: filePreviewSubtitle(kind),
    path: trimmed,
    statusText: formatFilePreviewStatus(state, canPreview, kind),
    copyStatus,
    canLoadPreview: canPreview && state.status !== 'ready',
    previewButtonLabel: loading ? '加载中' : '加载文本预览',
    previewButtonDisabled: loading,
  };
}

function compareFileBrowserEntries(a: MobileFileBrowserEntry, b: MobileFileBrowserEntry): number {
  if (a.kind !== b.kind) {
    if (a.kind === 'dir' || a.kind === 'symlink') return -1;
    if (b.kind === 'dir' || b.kind === 'symlink') return 1;
  }
  return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
}

function normalizeEntryKind(value: unknown): RemoteDirectoryEntryLike['kind'] | null {
  if (value === 'dir' || value === 'file' || value === 'symlink') return value;
  if (value === 'directory') return 'dir';
  return null;
}

function normalizeStatKind(value: unknown): RemotePathStatResultLike['kind'] | null {
  if (value === 'dir' || value === 'file' || value === 'missing') return value;
  if (value === 'directory') return 'dir';
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function readString(value: Record<string, unknown>, key: string): string | null {
  const raw = value[key];
  return typeof raw === 'string' && raw.length > 0 ? raw : null;
}
