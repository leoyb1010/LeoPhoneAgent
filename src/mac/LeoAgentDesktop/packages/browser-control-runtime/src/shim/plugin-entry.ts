/**
 * Shim: openclaw/plugin-sdk/plugin-entry.
 * Only the `OpenClawPluginService` type is referenced (by the dropped
 * sdk-node-runtime bridge). A structural placeholder is sufficient; no plugin
 * lifecycle runs in the in-process runtime.
 */
export type OpenClawPluginService = {
  start?(): void | Promise<void>;
  stop?(): void | Promise<void>;
  [key: string]: unknown;
};
