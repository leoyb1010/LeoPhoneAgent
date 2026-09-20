import os from 'node:os';
import path from 'node:path';

const BLOCKED_EXACT = new Set(['/', '/etc', '/bin', '/sbin', '/usr', '/dev', '/proc', '/sys', '/var', '/boot', '/root', '/lib', '/lib64', '/opt', '/run']);
const BLOCKED_PREFIX = ['/etc/', '/dev/', '/proc/', '/sys/', '/boot/', '/root/'];

export function expandDesktopFolderPath(raw, home = os.homedir()) {
  const text = String(raw ?? '').trim();
  if (!text || text === '~') return home;
  if (text.startsWith('~/') || text.startsWith('~\\')) return path.join(home, text.slice(2));
  return text;
}

export function isDesktopFolderAllowed(raw, home = os.homedir()) {
  const resolved = path.resolve(expandDesktopFolderPath(raw, home));
  if (BLOCKED_EXACT.has(resolved)) return false;
  return !BLOCKED_PREFIX.some((prefix) => resolved.startsWith(prefix));
}
