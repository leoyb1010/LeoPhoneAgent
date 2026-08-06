import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

interface BashTestEnvironment {
  available: boolean;
  command: string;
  path: string;
  toPath(value: string): string;
}

/** Every `bash` executable visible to the test process, in PATH order. */
function bashCandidates(): string[] {
  if (process.platform !== 'win32') return ['bash'];
  const listed = spawnSync('where.exe', ['bash'], { encoding: 'utf8' });
  if (listed.status !== 0) return [];
  return listed.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

/** Probe a bash binary for its kernel name and native PATH. */
function probeBash(command: string): { kernel: string; path: string } | null {
  const probe = spawnSync(command, ['-lc', 'uname -s; printf "\\n%s" "$PATH"'], {
    encoding: 'utf8',
  });
  if (probe.status !== 0) return null;
  const [kernel = '', ...pathLines] = probe.stdout.split(/\r?\n/);
  return { kernel: kernel.trim(), path: pathLines.join('\n') };
}

/** Build the Windows→POSIX path converter for a chosen MSYS/MINGW/Cygwin bash. */
function makeWindowsPathConverter(command: string, kernel: string): (value: string) => string {
  return (value: string): string => {
    const converted = spawnSync(command, ['-lc', 'cygpath -a "$1"', 'bash-path', value], {
      encoding: 'utf8',
    });
    if (converted.status !== 0 || !converted.stdout.trim()) {
      throw new Error(`Unable to convert Windows path for ${kernel || 'bash'}: ${value}`);
    }
    return converted.stdout.trim();
  };
}

/**
 * Resolve the Bash flavor visible to tests and its native PATH.
 *
 * On Windows a machine often exposes several `bash.exe` — WSL's launcher in
 * System32 plus a Git-for-Windows (MINGW/MSYS) bash — and PATH order is not
 * guaranteed. WSL is a separate Linux environment: Windows spawn env overrides
 * (fake curl, credentials path, PATH) are not forwarded unless WSLENV is
 * mutated, so these filesystem-sharing script tests cannot run under it. Linux
 * CI already covers the scripts, so on Windows we scan every candidate and only
 * accept an in-process POSIX layer (MINGW/MSYS/CYGWIN) that shares the Windows
 * filesystem and environment; if none exists the caller skips the suite.
 */
export function resolveBashTestEnvironment(): BashTestEnvironment {
  const isWindows = process.platform === 'win32';
  for (const command of bashCandidates()) {
    const probed = probeBash(command);
    if (!probed) continue;
    if (isWindows && !/^(MINGW|MSYS|CYGWIN)/i.test(probed.kernel)) continue;
    return {
      available: true,
      command,
      path: probed.path,
      toPath: isWindows ? makeWindowsPathConverter(command, probed.kernel) : (value) => value,
    };
  }
  return { available: false, command: '', path: '', toPath: (value) => value };
}

/** Check a command inside the same Bash environment used by the script tests. */
export function bashCommandWorks(
  environment: BashTestEnvironment,
  command: string,
): boolean {
  if (!environment.available) return false;
  return spawnSync(environment.command, ['-lc', command], {
    encoding: 'utf8',
  }).status === 0;
}

/**
 * Keep a test-local bin directory first after Bash has finished its own startup.
 *
 * Git for Windows prepends `/mingw64/bin:/usr/bin` while starting bash.exe,
 * even when the parent process already put a fake tool directory first. Bash
 * reads BASH_ENV after that rewrite, so a tiny test-local startup file restores
 * the intended order for the release-script process and every child bash.
 */
export function withBashTestBin(
  environment: BashTestEnvironment,
  binDir: string,
  env: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const bashBinDir = environment.toPath(binDir);
  const bashEnvPath = join(dirname(binDir), 'bash-env');
  writeFileSync(bashEnvPath, 'export PATH="$XDT_TEST_BIN_DIR:$PATH"\n');
  return {
    ...env,
    BASH_ENV: environment.toPath(bashEnvPath),
    XDT_TEST_BIN_DIR: bashBinDir,
    PATH: `${bashBinDir}:${environment.path}`,
  };
}
