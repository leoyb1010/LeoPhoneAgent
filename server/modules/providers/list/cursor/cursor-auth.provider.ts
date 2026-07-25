import type { IProviderAuth } from '@/shared/interfaces.js';
import type { ProviderAuthStatus } from '@/shared/types.js';
import {
  readCliInstallProbe,
  runProviderCliCommand,
  type CliCommandRunner,
  type CliInstallProbe,
  type CliProbeProcessResult,
} from '@/modules/providers/services/cli-version.util.js';

type CursorLoginStatus = {
  authenticated: boolean;
  email: string | null;
  method: string | null;
  error?: string;
};

export function parseCursorLoginStatus(output: string): CursorLoginStatus {
  const emailMatch = output.match(/Logged in as ([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/i);
  if (emailMatch?.[1]) {
    return { authenticated: true, email: emailMatch[1], method: 'cli' };
  }
  if (/Login successful|Logged in/i.test(output)) {
    // Logged in but the address wasn't in the output — `null` lets the UI show
    // its own localized label rather than a stray English string.
    return { authenticated: true, email: null, method: 'cli' };
  }
  return { authenticated: false, email: null, method: null, error: 'Not logged in' };
}

export class CursorProviderAuth implements IProviderAuth {
  constructor(private readonly runCommand: CliCommandRunner = runProviderCliCommand) {}

  private run(args: string[], timeout = 5000): Promise<CliProbeProcessResult> {
    return this.runCommand('cursor-agent', args, timeout);
  }

  private async probeInstall(): Promise<CliInstallProbe> {
    try {
      const result = await this.run(['--version']);
      return readCliInstallProbe(result, 'cursor-agent');
    } catch (error) {
      return readCliInstallProbe({ error, status: null }, 'cursor-agent');
    }
  }

  async getStatus(): Promise<ProviderAuthStatus> {
    const install = await this.probeInstall();
    const { installed, version } = install;
    if (!installed) {
      return {
        installed: false,
        provider: 'cursor',
        authenticated: false,
        email: null,
        method: null,
        version: null,
        error: 'Cursor CLI is not installed',
      };
    }

    // Don't let a failed `--version` probe (e.g. `spawn EBADF` in the GUI-launched
    // app) mask the login state — proceed to the auth check below.

    const login = await this.checkCursorLogin();
    return {
      installed: true,
      provider: 'cursor',
      authenticated: login.authenticated,
      email: login.email,
      method: login.method,
      version,
      error: login.error || (login.authenticated ? undefined : 'Not logged in'),
    };
  }

  private async checkCursorLogin(): Promise<CursorLoginStatus> {
    try {
      const statusResult = await this.run(['status']);
      const statusOutput = `${statusResult.stdout || ''}\n${statusResult.stderr || ''}`;
      if (statusResult.error || statusResult.status !== 0) {
        return { authenticated: false, email: null, method: null, error: statusOutput.trim() || 'Not logged in' };
      }

      const login = parseCursorLoginStatus(statusOutput);
      if (!login.authenticated) return login;

      // `cursor-agent status` can report a stale keychain entry as logged in.
      // Listing models performs the lightweight authenticated request used by real sessions.
      const capabilityResult = await this.run(['--list-models'], 10_000);
      if (capabilityResult.error || capabilityResult.status !== 0) {
        const capabilityOutput = `${capabilityResult.stdout || ''}\n${capabilityResult.stderr || ''}`.trim();
        const capabilityError = capabilityOutput
          || (capabilityResult.error instanceof Error
            ? capabilityResult.error.message
            : String(capabilityResult.error || 'unknown error'));
        if (!/authentication required|not logged in|unauthorized|invalid credentials?|\b401\b/i.test(capabilityError)) {
          return {
            ...login,
            error: `Cursor is logged in, but its service capability check failed: ${capabilityError}`,
          };
        }
        return {
          authenticated: false,
          email: login.email,
          method: login.method,
          error: 'Cursor credentials are present but unusable. Run cursor-agent login again.',
        };
      }
      return login;
    } catch {
      return { authenticated: false, email: null, method: null, error: 'Cursor CLI authentication check failed' };
    }
  }
}
