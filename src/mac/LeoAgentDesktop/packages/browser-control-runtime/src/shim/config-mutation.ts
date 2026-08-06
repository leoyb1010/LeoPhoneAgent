/**
 * Shim: openclaw/plugin-sdk/config-mutation.
 *
 * Upstream persists config edits to the OpenClaw config file. The browser
 * runtime's config is host-managed (in-memory), so these apply the mutator to
 * the in-memory config — no file IO. Call shape mirrors upstream:
 *   mutateConfigFile<T>({ afterWrite?, mutate }) → Promise<T | undefined>
 */
import { getRuntimeConfig, setBrowserRuntimeConfig } from './runtime-config-snapshot.js';
import type { OpenClawConfig } from './config-contracts.js';

export interface MutateConfigFileOptions<T> {
  afterWrite?: { mode?: string };
  mutate: (draft: OpenClawConfig) => T | Promise<T>;
}

/**
 * Apply a mutator to the in-memory config (no file write). Mirrors upstream:
 * returns `{ result }` where `result` is the mutate() return value.
 */
export async function mutateConfigFile<T = void>(
  options: MutateConfigFileOptions<T>,
): Promise<{ result: T }> {
  const next = structuredClone(getRuntimeConfig());
  const result = await options.mutate(next);
  setBrowserRuntimeConfig(next);
  return { result };
}

/** Replace the in-memory config wholesale. */
export function replaceConfigFile(next: OpenClawConfig): OpenClawConfig {
  setBrowserRuntimeConfig(next);
  return next;
}
