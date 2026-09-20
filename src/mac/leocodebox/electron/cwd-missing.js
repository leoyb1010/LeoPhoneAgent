import { statSync } from 'node:fs';

import { expandDesktopFolderPath } from './local-folder.js';

export function cwdStillThere(raw, stat = statSync) {
  const text = String(raw ?? '').trim();
  if (!text) return true;
  try {
    return Boolean(stat(expandDesktopFolderPath(text)).isDirectory());
  } catch {
    return false;
  }
}
