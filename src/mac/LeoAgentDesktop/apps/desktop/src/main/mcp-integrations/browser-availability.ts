/**
 * Pure browser-availability helpers — intentionally electron-free so they are
 * unit-testable without booting Electron. Imported by mcp-integrations/browser.ts
 * (which adds the electron-coupled runtime/IPC wiring on top).
 */

/** Local browser detection result surfaced to Settings →「电脑使用」. */
export interface BrowserAvailability {
  /** Whether a usable local browser executable was detected. */
  detected: boolean;
  /** Detected browser kind (e.g. "chrome" / "edge" / "brave"), if any. */
  browserKind: string | null;
  /** Absolute path to the detected browser executable, if any. */
  executablePath: string | null;
}

/**
 * Maps the runtime `status` payload to a BrowserAvailability. The runtime
 * `status` action only probes detection — it never launches a browser — so
 * this is safe to call eagerly from the Settings UI.
 */
export function extractBrowserAvailability(statusData: unknown): BrowserAvailability {
  const data = (statusData ?? {}) as {
    detectedBrowser?: unknown;
    detectedExecutablePath?: unknown;
  };
  const executablePath =
    typeof data.detectedExecutablePath === 'string' && data.detectedExecutablePath.length > 0
      ? data.detectedExecutablePath
      : null;
  const browserKind =
    typeof data.detectedBrowser === 'string' && data.detectedBrowser.length > 0
      ? data.detectedBrowser
      : null;
  return { detected: executablePath !== null, browserKind, executablePath };
}
