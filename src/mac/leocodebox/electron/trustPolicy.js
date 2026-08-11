import path from 'node:path';
import { fileURLToPath } from 'node:url';

function resolveFileUrl(url) {
  try {
    const parsed = new URL(String(url));
    if (parsed.protocol !== 'file:') return null;
    return path.resolve(fileURLToPath(parsed));
  } catch {
    return null;
  }
}

export function isFirstPartyShellUrl(url, launcherPath) {
  const senderPath = resolveFileUrl(url);
  return Boolean(senderPath && senderPath === path.resolve(launcherPath));
}

export function isTrustedNavigationUrl({ currentUrl = '', targetUrl, allowedFilePaths = [] }) {
  let target;
  try {
    target = new URL(String(targetUrl));
  } catch {
    return false;
  }

  if (target.protocol === 'file:') {
    const targetPath = resolveFileUrl(target.href);
    return Boolean(targetPath && allowedFilePaths.some((allowedPath) => targetPath === path.resolve(allowedPath)));
  }

  if (target.protocol !== 'http:' && target.protocol !== 'https:') return false;

  try {
    const current = new URL(String(currentUrl));
    if (
      (current.protocol === 'http:' || current.protocol === 'https:')
      && current.origin === target.origin
    ) {
      return true;
    }
  } catch {
    // No committed page yet; continue with the fixed application allowlist.
  }

  const host = target.hostname;
  if (host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '[::1]') {
    return true;
  }
  return host === 'leocodebox.local' || host.endsWith('.leocodebox.local');
}
