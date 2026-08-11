/**
 * Shared helpers for reading provider CLI versions.
 *
 * Each provider CLI prints its version in a slightly different shape:
 *   codex-cli 0.144.1
 *   2.1.204 (Claude Code)
 *   1.17.15
 *   2026.06.26-7079533
 *
 * `parseCliVersion` extracts the first version-like token so the UI can show
 * exactly which build is installed instead of a bare installed/missing flag.
 */
import spawn from 'cross-spawn';

// First dotted-number run. No leading \b so a "v"-prefixed version (v1.2.3) still
// keeps its major component; a preceding digit/dot is excluded so we start at the
// real major.
const VERSION_TOKEN = /(?<![\d.])(\d+\.\d+[A-Za-z0-9.+_-]*)/;

export function parseCliVersion(output: string | null | undefined): string | null {
  if (!output) {
    return null;
  }
  const match = String(output).match(VERSION_TOKEN);
  return match?.[1] ?? null;
}

export type CliProbeProcessResult = {
  error?: unknown;
  status?: number | null;
  stdout?: string | Buffer | null;
  stderr?: string | Buffer | null;
};

export type CliCommandRunner = (
  command: string,
  args: string[],
  timeoutMs?: number,
) => Promise<CliProbeProcessResult>;

// `spawn EBADF` is a transient libuv fd race in the packaged GUI app (worst in
// the seconds right after launch). It must read as "retry shortly", never as
// "CLI broken" — without this, the account pane showed 认证状态检查失败 for
// every provider on startup. Mirrors the retry in leocodebox/cli-tools.routes.
const EBADF_RETRY_LIMIT = 5;
const EBADF_RETRY_DELAY_MS = 300;
function isTransientSpawnError(result: CliProbeProcessResult): boolean {
  const error = result.error;
  if (!error) return false;
  const text = error instanceof Error ? `${(error as NodeJS.ErrnoException).code || ''} ${error.message}` : String(error);
  return /EBADF/i.test(text);
}

export const runProviderCliCommand: CliCommandRunner = async (command, args, timeoutMs = 5000) => {
  let result = await runProviderCliCommandOnce(command, args, timeoutMs);
  for (let attempt = 0; attempt < EBADF_RETRY_LIMIT && isTransientSpawnError(result); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, EBADF_RETRY_DELAY_MS * (attempt + 1)));
    result = await runProviderCliCommandOnce(command, args, timeoutMs);
  }
  return result;
};

const runProviderCliCommandOnce: CliCommandRunner = (command, args, timeoutMs = 5000) => (
  new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      resolve({ error, status: null, stdout: '', stderr: '' });
      return;
    }

    let stdout = '';
    let stderr = '';
    let settled = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const finish = (result: CliProbeProcessResult) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      resolve({ ...result, stdout, stderr });
    };
    child.stdout?.on('data', (chunk) => { stdout += String(chunk); });
    child.stderr?.on('data', (chunk) => { stderr += String(chunk); });
    child.once('error', (error) => finish({ error, status: null }));
    child.once('close', (status) => finish({ status, error: undefined }));
    timeout = setTimeout(() => {
      const error = Object.assign(new Error(`${command} timed out after ${timeoutMs} ms`), { code: 'ETIMEDOUT' });
      child.kill('SIGTERM');
      finish({ error, status: null });
    }, timeoutMs);
  })
);

export type CliInstallProbe = {
  installed: boolean;
  runnable: boolean;
  version: string | null;
  error: string | null;
};

function readProcessErrorCode(error: unknown): string | null {
  if (!error || typeof error !== 'object' || !('code' in error)) return null;
  return typeof error.code === 'string' ? error.code : null;
}

export function readCliInstallProbe(result: CliProbeProcessResult, command: string): CliInstallProbe {
  const errorCode = readProcessErrorCode(result.error);
  const missing = errorCode === 'ENOENT';
  const runnable = !result.error && result.status === 0;
  const output = String(result.stdout || result.stderr || '').trim();
  const processError = result.error instanceof Error ? result.error.message : result.error ? String(result.error) : '';
  const error = missing
    ? `${command} executable was not found`
    : runnable
      ? null
      : output || processError || `${command} exited with status ${String(result.status ?? 'unknown')}`;

  return {
    installed: !missing,
    runnable,
    version: runnable ? parseCliVersion(output) : null,
    error,
  };
}
