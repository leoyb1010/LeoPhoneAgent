import fs from 'node:fs';
import path from 'node:path';

const MAX_CHARS = 80_000;
const ALLOW_PREFIX = ['/tmp/pi-bash-', '/private/tmp/pi-bash-', '/tmp/pi-tool-', '/private/tmp/pi-tool-'];

export function sessionToolFullPath(result?: unknown): string {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return '';
  const row = result as Record<string, unknown>;
  const details = row.details && typeof row.details === 'object' && !Array.isArray(row.details)
    ? row.details as Record<string, unknown>
    : {};
  const raw = String(details.fullOutputPath ?? row.fullOutputPath ?? '').trim();
  if (!raw || raw.includes('\0')) return '';
  const abs = path.resolve(raw);
  if (!ALLOW_PREFIX.some((prefix) => abs.startsWith(prefix))) return '';
  return abs;
}

export function sessionToolFullOutput(result: unknown, preview: string): string {
  const file = sessionToolFullPath(result);
  if (!file) return preview;
  try {
    const st = fs.statSync(file);
    if (!st.isFile() || st.size <= 0) return preview;
    const body = fs.readFileSync(file, 'utf8').replace(/\u0000/g, '').replace(/\s+$/, '');
    if (!body) return preview;
    const text = body.length > MAX_CHARS ? body.slice(-MAX_CHARS) : body;
    return text.length >= preview.length ? text : preview;
  } catch {
    return preview;
  }
}
