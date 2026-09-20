/** pi 把截断的命令全文写到 sidecar；只认它自己的那份。 */

export function sessionToolFullPath(result?: unknown): string {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return '';
  const row = result as Record<string, unknown>;
  const details = row.details && typeof row.details === 'object' && !Array.isArray(row.details)
    ? row.details as Record<string, unknown>
    : {};
  const raw = String(details.fullOutputPath ?? row.fullOutputPath ?? '').trim();
  if (!raw || raw.includes('\0')) return '';
  if (!/(^|\/)(tmp|private\/tmp)\/pi-(bash|tool)-/.test(raw.replace(/\\/g, '/'))) return '';
  return raw;
}
