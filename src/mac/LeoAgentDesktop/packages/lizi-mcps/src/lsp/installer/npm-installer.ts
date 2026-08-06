import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

import type { LiziMcpLogger } from '../../types.js';

export interface NpmInstallerOptions {
  userDataPath: string;
  logger: LiziMcpLogger;
}

/**
 * Installs the TypeScript language server into the host-provided userData cache
 * on first use. This stays package-local and does not depend on Electron APIs.
 */
export class NpmInstaller {
  private inflightTsls: Promise<string> | null = null;

  constructor(private readonly opts: NpmInstallerOptions) {}

  ensureTypescriptLanguageServer(): Promise<string> {
    if (this.inflightTsls) return this.inflightTsls;
    this.inflightTsls = this.installTsls().catch((err) => {
      this.inflightTsls = null;
      throw err;
    });
    return this.inflightTsls;
  }

  private async installTsls(): Promise<string> {
    const installDir = path.join(this.opts.userDataPath, 'lsp-servers', 'typescript-language-server');
    const cliEntry = path.join(
      installDir,
      'node_modules',
      'typescript-language-server',
      'lib',
      'cli.mjs',
    );

    if (await exists(cliEntry)) return cliEntry;

    await fs.mkdir(installDir, { recursive: true });
    this.opts.logger.info('installing typescript-language-server', { installDir });
    await this.execNpmInstall(installDir);

    if (!(await exists(cliEntry))) {
      throw new Error(`typescript-language-server install completed but cli.mjs was not found: ${cliEntry}`);
    }
    return cliEntry;
  }

  private execNpmInstall(cwd: string): Promise<void> {
    const packages = ['typescript-language-server@latest', 'typescript@latest'];
    const command = process.platform === 'win32' ? 'cmd.exe' : 'npm';
    const args =
      process.platform === 'win32'
        ? ['/d', '/s', '/c', 'npm', 'install', '--no-audit', '--no-fund', ...packages]
        : ['install', '--no-audit', '--no-fund', ...packages];

    return new Promise((resolve, reject) => {
      const child = spawn(command, args, {
        cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: false,
        windowsHide: true,
      });

      let stderr = '';
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk: string) => {
        stderr += chunk;
        if (stderr.length > 4_000) stderr = stderr.slice(-4_000);
      });
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        const line = chunk.trim();
        if (line) this.opts.logger.debug('npm install output', { line: line.slice(0, 1_000) });
      });

      child.on('error', reject);
      child.on('exit', (code, signal) => {
        if (code === 0) {
          resolve();
          return;
        }
        reject(new Error(`npm install failed (${signal ?? code ?? 'unknown'}): ${stderr.trim()}`));
      });
    });
  }
}

async function exists(file: string): Promise<boolean> {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}
