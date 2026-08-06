import type { NpmInstaller } from '../installer/npm-installer.js';
import type { LspServerProcess } from '../server/lsp-server-process.js';

export interface LanguageServerLauncher {
  language: string;
  launch(workdir: string, installer: NpmInstaller): Promise<LspServerProcess>;
}
