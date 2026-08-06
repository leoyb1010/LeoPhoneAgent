/**
 * Shim: openclaw/plugin-sdk/plugin-runtime.
 * Lazy plugin-service module loading used only by the dropped sdk-node-runtime
 * bridge. Not invoked in the in-process runtime.
 */
export type LazyPluginServiceHandle = {
  dispose?: () => void | Promise<void>;
  [key: string]: unknown;
};

export function startLazyPluginServiceModule(): LazyPluginServiceHandle {
  return {};
}
