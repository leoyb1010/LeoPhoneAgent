import { sameCwdSessions, type SameCwdSession } from './session-here';

export function parseLeoScheme(raw?: string | null): { cwd: string } | null {
  const text = String(raw ?? '').trim();
  if (!text) return null;
  let url: URL;
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

export function canOpenLeoScheme(desktop?: { onLeoScheme?: unknown } | null): boolean {
  return Boolean(desktop?.onLeoScheme);
}

export function pickSchemeSession<T extends {
  machine?: string | null;
  s: { session_id?: string | null; cwd?: string | null; title?: string | null; updated_at?: number | null };
}>(rows: readonly T[], cwd?: string | null): SameCwdSession | null {
  return sameCwdSessions(rows, cwd, null)[0] ?? null;
}

export function leoSchemeToast(title?: string | null): string {
  const name = (title ?? '').replace(/\s+/g, ' ').trim();
  return name ? `已打开「${name}」` : '已打开这个目录';
}
