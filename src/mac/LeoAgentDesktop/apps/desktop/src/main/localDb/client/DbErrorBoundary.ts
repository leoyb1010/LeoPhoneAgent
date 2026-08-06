import { createLogger } from '../../logger.js';

const log = createLogger('db-worker');

export interface DbErrorBoundaryOptions {
  maxAutoRestart?: number;
}

export class DbErrorBoundary {
  private terminatedCount = 0;
  private readonly maxAutoRestart: number;

  constructor(options: DbErrorBoundaryOptions = {}) {
    this.maxAutoRestart = options.maxAutoRestart ?? 1;
  }

  async wrap<T>(opName: string, fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      log.error('db client rpc failed', {
        op: opName,
        err: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  }

  onWorkerTerminated(info: { code: number | null; signal: string | null }): {
    shouldRestart: boolean;
  } {
    this.terminatedCount += 1;
    const shouldRestart = this.terminatedCount <= this.maxAutoRestart;
    log.warn('db worker terminated', {
      code: info.code,
      signal: info.signal,
      terminatedCount: this.terminatedCount,
      shouldRestart,
    });
    return { shouldRestart };
  }
}
