import { readFile } from 'node:fs/promises';
import path from 'node:path';

import type { IProviderAuth } from '@/shared/interfaces.js';
import type { ProviderAuthStatus } from '@/shared/types.js';
import {
  readCliInstallProbe,
  runProviderCliCommand,
  type CliCommandRunner,
  type CliInstallProbe,
} from '@/modules/providers/services/cli-version.util.js';
import { getOpenCodeDataDir } from '@/shared/provider-runtime-paths.js';
import { readObjectRecord, readOptionalString } from '@/shared/utils.js';

type OpenCodeCredentialsStatus = {
  authenticated: boolean;
  email: string | null;
  method: string | null;
  error?: string;
};

const OPENCODE_ENV_CREDENTIAL_KEYS = [
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'GOOGLE_GENERATIVE_AI_API_KEY',
  'GROQ_API_KEY',
  'OPENROUTER_API_KEY',
];

export class OpenCodeProviderAuth implements IProviderAuth {
  constructor(private readonly runCommand: CliCommandRunner = runProviderCliCommand) {}

  /**
   * Checks whether the OpenCode CLI is available to the server process and reads its version.
   */
  private async probeInstall(): Promise<CliInstallProbe> {
    try {
      const result = await this.runCommand('opencode', ['--version'], 5000);
      return readCliInstallProbe(result, 'opencode');
    } catch (error) {
      return readCliInstallProbe({ error, status: null }, 'opencode');
    }
  }

  /**
   * Returns OpenCode CLI installation and credential status.
   */
  async getStatus(): Promise<ProviderAuthStatus> {
    const install = await this.probeInstall();
    const { installed, version } = install;
    if (!installed) {
      return {
        installed: false,
        provider: 'opencode',
        authenticated: false,
        email: null,
        method: null,
        version: null,
        error: 'OpenCode CLI is not installed',
      };
    }
    // Don't let a failed `--version` probe (e.g. `spawn EBADF` in the GUI-launched
    // app) mask the login state — proceed to the file-based auth check below.
    const credentials = await this.checkCredentials();

    return {
      installed,
      provider: 'opencode',
      authenticated: credentials.authenticated,
      email: credentials.email,
      method: credentials.method,
      version,
      error: credentials.authenticated ? undefined : credentials.error || 'Not authenticated',
    };
  }

  /**
   * Reads OpenCode's auth store or falls back to provider API key environment variables.
   */
  private async checkCredentials(): Promise<OpenCodeCredentialsStatus> {
    try {
      const authPath = path.join(getOpenCodeDataDir(), 'auth.json');
      const content = await readFile(authPath, 'utf8');
      const auth = readObjectRecord(JSON.parse(content)) ?? {};

      for (const [providerId, providerAuth] of Object.entries(auth)) {
        const providerRecord = readObjectRecord(providerAuth);
        if (!providerRecord) {
          continue;
        }

        const hasCredentialValue = (value: unknown): boolean => {
          if (readOptionalString(value) !== undefined) return true;
          const record = readObjectRecord(value);
          return Boolean(record && Object.values(record).some(hasCredentialValue));
        };
        const hasCredential = Object.values(providerRecord).some(hasCredentialValue);
        if (hasCredential) {
          return {
            authenticated: true,
            // The bare provider id ("xai") — which credential is in use is the
            // useful part, and it reads the same in any UI language, unlike the
            // old "<id> credentials" English label.
            email: providerId,
            method: 'credentials_file',
          };
        }
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') {
        return {
          authenticated: false,
          email: null,
          method: null,
          error: error instanceof Error ? error.message : 'Failed to read OpenCode auth',
        };
      }
    }

    const envCredential = OPENCODE_ENV_CREDENTIAL_KEYS.find((key) => process.env[key]?.trim());
    if (envCredential) {
      return {
        authenticated: true,
        email: envCredential,
        method: 'environment',
      };
    }

    return {
      authenticated: false,
      email: null,
      method: null,
      error: 'OpenCode not configured',
    };
  }
}
