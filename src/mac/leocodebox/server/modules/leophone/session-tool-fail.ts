/** 命令退出码不是 0 时，这一行要标失败，不能当跑完。 */

const EXIT_TOOLS = new Set(['bash', 'powershell']);

export function sessionToolExitCode(result?: unknown): number | null {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return null;
  const row = result as Record<string, unknown>;
  const details = row.details && typeof row.details === 'object' && !Array.isArray(row.details)
    ? row.details as Record<string, unknown>
    : {};
  const raw = details.exitCode ?? row.exitCode;
  if (raw == null || raw === '') return null;
  const code = Number(raw);
  return Number.isFinite(code) ? code : null;
}

export function sessionToolFailed(input: {
  tool?: string | null;
  isError?: unknown;
  result?: unknown;
} = {}): boolean {
  if (input.isError) return true;
  if (!EXIT_TOOLS.has(String(input.tool ?? ''))) return false;
  const code = sessionToolExitCode(input.result);
  return code != null && code !== 0;
}
