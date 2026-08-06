import type { LiziMcpLogger } from '../../types.js';
import type { NpmInstaller } from '../installer/npm-installer.js';
import { LspServerProcess } from '../server/lsp-server-process.js';
import type { LanguageServerLauncher } from './base.js';

/**
 * TypeScript-only launcher for Phase 1. It runs cli.mjs through process.execPath
 * to avoid Windows npm .cmd shims.
 */
export class TypescriptLauncher implements LanguageServerLauncher {
  readonly language = 'typescript';

  constructor(private readonly logger: LiziMcpLogger) {}

  async launch(workdir: string, installer: NpmInstaller): Promise<LspServerProcess> {
    const cliPath = await installer.ensureTypescriptLanguageServer();
    const env = {
      ...process.env,
      // Electron's executable can run Node scripts when this flag is set. In a
      // plain Node host the flag is harmless; in Electron it avoids .cmd shims.
      ELECTRON_RUN_AS_NODE: '1',
    };
    const proc = new LspServerProcess({
      command: process.execPath,
      args: [cliPath, '--stdio'],
      cwd: workdir,
      env,
      logger: this.logger,
    });
    proc.spawn();
    return proc;
  }
}
