import { statSync } from 'node:fs';
import path from 'node:path';

export function cwdFromDroppedPath(raw) {
  const text = String(raw ?? '').trim();
  if (!text) return '';
  try {
    const info = statSync(text);
    if (info.isDirectory()) return text;
    if (info.isFile()) return path.dirname(text);
  } catch {
    return text;
  }
  return text;
}

export function rememberRecentCwd(appLike, cwd) {
  const text = String(cwd ?? '').trim();
  if (!text || typeof appLike?.addRecentDocument !== 'function') return false;
  try {
    appLike.addRecentDocument(text);
    return true;
  } catch {
    return false;
  }
}

export function folderDocumentTypes() {
  return [{
    CFBundleTypeName: 'Folders',
    CFBundleTypeRole: 'Viewer',
    LSHandlerRank: 'Alternate',
    LSItemContentTypes: ['public.folder', 'public.directory'],
  }];
}
