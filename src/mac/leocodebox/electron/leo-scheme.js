import { expandDesktopFolderPath, isDesktopFolderAllowed } from './local-folder.js';

export function parseLeoScheme(raw) {
  const text = String(raw ?? '').trim();
  if (!text) return null;
  let url;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  if (url.protocol !== 'leocodebox:') return null;
  const fromQuery = String(url.searchParams.get('cwd') ?? '').trim();
  if (fromQuery) return { cwd: fromQuery };
  let pathname = '';
  try {
    pathname = decodeURIComponent(url.pathname || '');
  } catch {
    pathname = url.pathname || '';
  }
  if (pathname.startsWith('/') && pathname.length > 1) return { cwd: pathname };
  return null;
}

export function resolveLeoSchemeCwd(raw, home) {
  const parsed = parseLeoScheme(raw);
  if (!parsed?.cwd) return null;
  if (!isDesktopFolderAllowed(parsed.cwd, home)) return null;
  return expandDesktopFolderPath(parsed.cwd, home);
}
