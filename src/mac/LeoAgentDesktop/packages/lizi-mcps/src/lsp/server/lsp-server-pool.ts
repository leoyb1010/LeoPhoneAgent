import path from 'node:path';
import { pathToFileURL } from 'node:url';

import type { LiziMcpLogger } from '../../types.js';
import { LspMcpError } from '../errors.js';
import { NpmInstaller } from '../installer/npm-installer.js';
import type { LanguageServerLauncher } from '../launcher/base.js';
import { TypescriptLauncher } from '../launcher/typescript.js';
import type { LspServerProcess } from './lsp-server-process.js';

interface ServerEntry {
  proc: LspServerProcess;
  lastUsed: number;
}

/**
 * Workdir-scoped language-server pool with lazy spawn and idle cleanup.
 */
export class LspServerPool {
  private readonly servers = new Map<string, ServerEntry>();
  private readonly startPromises = new Map<string, Promise<LspServerProcess>>();
  private readonly installer: NpmInstaller;
  private readonly launchers: ReadonlyMap<string, LanguageServerLauncher>;
  private idleTimer: NodeJS.Timeout | null = null;
  private shuttingDown = false;

  constructor(
    private readonly deps: {
      userDataPath: string;
      logger: LiziMcpLogger;
      idleTimeoutMs?: number;
    },
  ) {
    this.installer = new NpmInstaller({
      userDataPath: deps.userDataPath,
      logger: deps.logger,
    });
    const tsLauncher = new TypescriptLauncher(deps.logger);
    this.launchers = new Map([[tsLauncher.language, tsLauncher]]);
  }

  async getOrSpawn(workdir: string, language: string): Promise<LspServerProcess> {
    if (this.shuttingDown) throw new LspMcpError('LSP_NOT_READY', 'LspServerPool is shutting down');
    const normalizedWorkdir = path.resolve(workdir);
    const key = this.key(normalizedWorkdir, language);
    const existing = this.servers.get(key);
    if (existing) {
      existing.lastUsed = Date.now();
      return existing.proc;
    }
    const inFlight = this.startPromises.get(key);
    if (inFlight) return inFlight;

    const launcher = this.launchers.get(language);
    if (!launcher) throw new LspMcpError('LSP_NOT_READY', `unsupported language: ${language}`);

    const start = this.spawnAndInitialize(normalizedWorkdir, language, launcher)
      .then((proc) => {
        // Race guard: if shutdown() ran between getOrSpawn() and this .then resolving,
        // it already snapshotted startPromises and will collect this proc via settledStarts.
        // Skip servers.set so we don't leak a live proc back into a "drained" pool.
        if (this.shuttingDown) return proc;
        this.servers.set(key, { proc, lastUsed: Date.now() });
        this.scheduleIdleCheck();
        return proc;
      })
      .finally(() => this.startPromises.delete(key));
    this.startPromises.set(key, start);
    return start;
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }

    const inFlight = Array.from(this.startPromises.values());
    this.startPromises.clear();
    const settledStarts = await Promise.allSettled(inFlight);
    const entries = Array.from(this.servers.entries());
    this.servers.clear();
    const procs = new Set([
      ...entries.map(([, entry]) => entry.proc),
      ...settledStarts
        .filter((result): result is PromiseFulfilledResult<LspServerProcess> => result.status === 'fulfilled')
        .map((result) => result.value),
    ]);
    await Promise.allSettled(Array.from(procs, (proc) => proc.shutdown()));
    this.shuttingDown = false;
  }

  private async spawnAndInitialize(
    workdir: string,
    language: string,
    launcher: LanguageServerLauncher,
  ): Promise<LspServerProcess> {
    this.deps.logger.info('starting LSP server', { workdir, language });
    const proc = await launcher.launch(workdir, this.installer);
    await proc.initialize(pathToFileURL(workdir).toString());
    this.deps.logger.info('LSP server initialized', { workdir, language });
    return proc;
  }

  private scheduleIdleCheck(): void {
    if (this.idleTimer) return;
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      void this.reapIdleServers();
    }, this.deps.idleTimeoutMs ?? 10 * 60 * 1000);
    this.idleTimer.unref?.();
  }

  private async reapIdleServers(): Promise<void> {
    const timeoutMs = this.deps.idleTimeoutMs ?? 10 * 60 * 1000;
    const now = Date.now();
    const shutdowns: Promise<void>[] = [];

    for (const [key, entry] of this.servers) {
      if (now - entry.lastUsed < timeoutMs) continue;
      this.servers.delete(key);
      shutdowns.push(entry.proc.shutdown());
    }

    await Promise.allSettled(shutdowns);
    if (this.servers.size > 0) this.scheduleIdleCheck();
  }

  private key(workdir: string, language: string): string {
    return `${workdir}::${language}`;
  }
}
