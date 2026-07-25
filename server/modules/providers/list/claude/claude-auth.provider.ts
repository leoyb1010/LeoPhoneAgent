import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { resolveClaudeCodeExecutablePath } from '@/shared/claude-cli-path.js';
import type { IProviderAuth } from '@/shared/interfaces.js';
import type { ProviderAuthStatus } from '@/shared/types.js';
import {
  readCliInstallProbe,
  runProviderCliCommand,
  type CliCommandRunner,
  type CliInstallProbe,
} from '@/modules/providers/services/cli-version.util.js';
import { getClaudeConfigDir } from '@/shared/provider-runtime-paths.js';
import { readObjectRecord, readOptionalString } from '@/shared/utils.js';

type ClaudeCredentialsStatus = {
  authenticated: boolean;
  email: string | null;
  method: string | null;
  error?: string;
};

export type ClaudeCliAuthStatus = {
  authenticated: boolean;
  email: string | null;
  method: string | null;
};

export function parseClaudeCliAuthStatus(output: string): ClaudeCliAuthStatus | null {
  try {
    const value = readObjectRecord(JSON.parse(output));
    if (typeof value?.loggedIn !== 'boolean') return null;

    return {
      authenticated: value.loggedIn,
      email: readOptionalString(value.email) ?? readOptionalString(value.account) ?? null,
      method: value.loggedIn ? readOptionalString(value.authMethod) ?? null : null,
    };
  } catch {
    return null;
  }
}

const hasErrorCode = (error: unknown, code: string): boolean => (
  error instanceof Error && 'code' in error && error.code === code
);

/**
 * The signed-in account's email, read from Claude Code's own config file.
 * `.credentials.json` carries only tokens, so without this the account tile
 * fell back to the literal placeholder "Authenticated" while every sibling
 * provider showed a real address. Read from disk (never spawned), so it also
 * works in the packaged GUI app where spawning the CLI can fail.
 */
async function readAccountEmail(): Promise<string | null> {
  // A custom CLAUDE_CONFIG_DIR keeps the config inside it; the default install
  // keeps ~/.claude.json beside the ~/.claude dir. Exactly one location — never
  // fall back across that boundary, or a configured directory would silently
  // leak the machine account.
  const configPath = process.env.CLAUDE_CONFIG_DIR?.trim()
    ? path.join(getClaudeConfigDir(), '.claude.json')
    : path.join(os.homedir(), '.claude.json');
  try {
    const parsed = readObjectRecord(JSON.parse(await readFile(configPath, 'utf8')));
    return readOptionalString(readObjectRecord(parsed?.oauthAccount)?.emailAddress) ?? null;
  } catch {
    return null; // missing or unreadable config is normal
  }
}

export class ClaudeProviderAuth implements IProviderAuth {
  constructor(private readonly runCommand: CliCommandRunner = runProviderCliCommand) {}

  /**
   * Checks whether the Claude Code CLI is available on this host and reads its version.
   */
  private async probeInstall(): Promise<CliInstallProbe> {
    const cliPath = resolveClaudeCodeExecutablePath(process.env.CLAUDE_CLI_PATH);
    try {
      const result = await this.runCommand(cliPath, ['--version'], 5000);
      return readCliInstallProbe(result, 'claude');
    } catch (error) {
      return readCliInstallProbe({ error, status: null }, 'claude');
    }
  }

  /**
   * Returns Claude installation and credential status using Claude Code's auth priority.
   */
  async getStatus(): Promise<ProviderAuthStatus> {
    const install = await this.probeInstall();
    const { installed, version } = install;

    if (!installed) {
      return {
        installed,
        provider: 'claude',
        authenticated: false,
        email: null,
        method: null,
        version: null,
        error: 'Claude Code CLI is not installed',
      };
    }

    // A failed `--version` probe (notably `spawn EBADF`, a persistent fd issue
    // when the app is GUI-launched without a controlling terminal) must NOT mask
    // the login state — credentials live in files we read without spawning. So
    // proceed to the auth check even when the version probe couldn't run; the
    // version stays null and cli/status is the source of truth for runnability.
    const credentials = await this.checkCredentials();

    return {
      installed,
      provider: 'claude',
      authenticated: credentials.authenticated,
      // No English placeholder: when the real address is unknown, `null` lets the
      // UI render its own localized "已登录" label instead of leaking a stray
      // English string into a Chinese account tile.
      email: credentials.email,
      method: credentials.method,
      version,
      error: credentials.authenticated ? undefined : credentials.error || 'Not authenticated',
    };
  }

  /**
   * Reads Claude settings env values that the CLI can use even when the server process env is empty.
   */
  private async loadSettingsEnv(): Promise<Record<string, unknown>> {
    try {
      const settingsPath = path.join(getClaudeConfigDir(), 'settings.json');
      const content = await readFile(settingsPath, 'utf8');
      const settings = readObjectRecord(JSON.parse(content));
      return readObjectRecord(settings?.env) ?? {};
    } catch {
      return {};
    }
  }

  /**
   * Checks Claude credentials in the same priority order used by Claude Code.
   */
  private async checkCredentials(): Promise<ClaudeCredentialsStatus> {
    const missingCredentialsError = 'Claude CLI is not authenticated. Run claude /login or configure ANTHROPIC_API_KEY.';

    // These branches authenticate via a key, not an account, so there is no
    // address to show — `method: 'api_key'` already carries that fact and the UI
    // renders its own localized label.
    if (process.env.ANTHROPIC_AUTH_TOKEN?.trim() || process.env.ANTHROPIC_API_KEY?.trim()) {
      return { authenticated: true, email: null, method: 'api_key' };
    }

    const settingsEnv = await this.loadSettingsEnv();
    if (readOptionalString(settingsEnv.ANTHROPIC_API_KEY) || readOptionalString(settingsEnv.ANTHROPIC_AUTH_TOKEN)) {
      return { authenticated: true, email: null, method: 'api_key' };
    }

    // Only a POSITIVE CLI result is authoritative. In the GUI-launched app the
    // spawned CLI's runtime env differs from the user's shell (and on macOS the
    // CLI may report `authMethod: none` even when a login exists), so a negative
    // `claude auth status` must NOT override a completed `claude /login` — fall
    // through to the on-disk OAuth token, which is the durable source of truth.
    const cliStatus = await this.checkCliAuthStatus();
    if (cliStatus?.authenticated) {
      return cliStatus;
    }

    try {
      const credPath = path.join(getClaudeConfigDir(), '.credentials.json');
      const content = await readFile(credPath, 'utf8');
      const creds = readObjectRecord(JSON.parse(content)) ?? {};
      const oauth = readObjectRecord(creds.claudeAiOauth);
      const accessToken = readOptionalString(oauth?.accessToken);

      if (accessToken) {
        const expiresAt = typeof oauth?.expiresAt === 'number' ? oauth.expiresAt : undefined;
        const email = readOptionalString(creds.email)
          ?? readOptionalString(creds.user)
          ?? await readAccountEmail();
        if (!expiresAt || Date.now() < expiresAt) {
          return {
            authenticated: true,
            email,
            method: 'credentials_file',
          };
        }

        // An EXPIRED access token is not a logout. Newer Claude Code keeps the
        // live credential outside this file (macOS Keychain) and stops
        // refreshing `.credentials.json`, so a stale `expiresAt` here says
        // nothing about the real session — and whenever a refreshToken is
        // present the CLI renews the access token silently on next use.
        // Treating that as "logged out" is what made a freshly completed
        // `claude /login` still show 未登录 in the app.
        const refreshToken = readOptionalString(oauth?.refreshToken);
        if (refreshToken) {
          return {
            authenticated: true,
            email,
            method: 'credentials_file',
          };
        }

        return {
          authenticated: false,
          email: null,
          method: null,
          error: 'Claude login has expired. Run claude /login again.',
        };
      }

      return {
        authenticated: false,
        email: null,
        method: null,
        error: missingCredentialsError,
      };
    } catch (error) {
      let errorMessage = 'Unable to read Claude credentials. Run claude /login again.';

      if (hasErrorCode(error, 'ENOENT')) {
        errorMessage = missingCredentialsError;
      } else if (error instanceof SyntaxError) {
        errorMessage = 'Claude credentials are unreadable. Run claude /login again.';
      }

      return {
        authenticated: false,
        email: null,
        method: null,
        error: errorMessage,
      };
    }
  }

  private async checkCliAuthStatus(): Promise<ClaudeCliAuthStatus | null> {
    const cliPath = resolveClaudeCodeExecutablePath(process.env.CLAUDE_CLI_PATH);
    try {
      const result = await this.runCommand(cliPath, ['auth', 'status'], 5000);
      if (result.error) return null;

      const stdout = String(result.stdout ?? '');
      const stderr = String(result.stderr ?? '');
      return parseClaudeCliAuthStatus(stdout.trim() || stderr.trim());
    } catch {
      return null;
    }
  }
}
