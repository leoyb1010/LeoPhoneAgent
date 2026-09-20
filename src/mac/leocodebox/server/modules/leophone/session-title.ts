import fs from 'node:fs';
import path from 'node:path';

export const SESSION_TITLE_MAX = 80;

export function clipSessionTitle(raw: string): string {
  return raw.replace(/[\r\n\u0000]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, SESSION_TITLE_MAX);
}

export function titleSidecarPath(logPath: string): string {
  return logPath.replace(/\.ndjson$/i, '.title');
}

export function readTitleSidecar(logPath: string): string {
  try {
    return clipSessionTitle(fs.readFileSync(titleSidecarPath(logPath), 'utf8'));
  } catch {
    return '';
  }
}

export function writeTitleSidecar(logPath: string, title: string): string {
  const next = clipSessionTitle(title);
  if (!next) throw new Error('写一个标题');
  const dest = titleSidecarPath(logPath);
  if (path.basename(dest).includes('..')) throw new Error('标题文件不合法');
  fs.writeFileSync(dest, next, 'utf8');
  return next;
}
