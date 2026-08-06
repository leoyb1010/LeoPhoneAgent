// External Chrome backend — wraps the vendored `BrowserControlRuntime` 1:1.
//
// This is the existing (and, in Phase 1, only) backend. It exists so the host
// can talk to *any* control target through the same `BrowserBackend` contract,
// not because the wrapping changes anything: every `call` is a direct
// delegation, and `dispose` reuses the existing electron-free
// `stopRuntimeForQuit` (which already swallows errors per the quit-path
// contract — see browser-dispose.ts).

import { stopRuntimeForQuit } from '../browser-dispose.js';
import type {
  BackendRequest,
  BackendResult,
  BackendRuntimeShape,
  BrowserBackend,
} from './types.js';

/** Minimal logger surface used here — matches the unified logger's `warn`. */
interface BackendLogger {
  warn(message: string, ...args: unknown[]): void;
}

export class ExternalChromeBackend implements BrowserBackend {
  readonly kind = 'external' as const;

  constructor(
    private readonly runtime: BackendRuntimeShape,
    private readonly logger: BackendLogger,
  ) {}

  call(request: BackendRequest): Promise<BackendResult> {
    return this.runtime.call(request);
  }

  /**
   * Quit-time cleanup. Stops the managed Chrome process so it does not outlive
   * the app. Delegates to `stopRuntimeForQuit`, which logs-and-swallows so the
   * disposer chain cannot stall here.
   *
   * Idempotent: a follow-up `stop` against an already-stopped runtime is a
   * no-op at the vendored layer; safe to call multiple times across backend
   * switches and app quit.
   */
  dispose(): Promise<void> {
    return stopRuntimeForQuit(this.runtime, this.logger);
  }
}
