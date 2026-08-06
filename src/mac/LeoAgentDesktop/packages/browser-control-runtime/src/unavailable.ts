import type {
  BrowserControlRequest,
  BrowserControlResult,
  BrowserControlRuntime,
} from './types.js';

/**
 * Placeholder runtime used until a host wires the upstream-synced browser core.
 */
export function createUnavailableBrowserRuntime(
  message = 'Browser automation runtime is not configured.',
): BrowserControlRuntime {
  return {
    async call(request: BrowserControlRequest): Promise<BrowserControlResult> {
      return {
        ok: false,
        action: request.action,
        errorCode: 'BROWSER_RUNTIME_NOT_CONFIGURED',
        message,
      };
    },
  };
}
