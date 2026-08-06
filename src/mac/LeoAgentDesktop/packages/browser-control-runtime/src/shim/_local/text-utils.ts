/**
 * Self-contained text/path helpers for the browser runtime shim.
 *
 * Upstream's text-utility-runtime pulls the OpenClaw config-dir + home-dir
 * machinery. The browser core only needs: regex escaping, home-relative path
 * expansion, home shortening for display, and a scratch CONFIG_DIR. We keep
 * these faithful but standalone (node builtins only). CONFIG_DIR defaults to a
 * neutral per-user scratch dir and is overridable via env.
 */
import os from 'node:os';
import path from 'node:path';

export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Expand a leading `~` / `~/...` to the user home directory. */
export function resolveUserPath(
  input: string,
  _env: NodeJS.ProcessEnv = process.env,
  homedir: () => string = os.homedir,
): string {
  if (!input) return '';
  if (input === '~') return homedir();
  if (input.startsWith('~/') || input.startsWith('~\\')) {
    return path.join(homedir(), input.slice(2));
  }
  return input;
}

/** Replace a leading home dir in a path with `~` for display. */
export function shortenHomePath(input: string): string {
  if (!input) return input;
  const home = os.homedir();
  if (input === home) return '~';
  if (input.startsWith(`${home}/`) || input.startsWith(`${home}\\`)) {
    return `~${input.slice(home.length)}`;
  }
  return input;
}

/**
 * Scratch/config directory for browser runtime state. Neutral, overridable.
 * Not tied to any product config layout.
 */
export const CONFIG_DIR: string =
  process.env.XDT_BROWSER_RUNTIME_DIR?.trim() ||
  path.join(os.homedir(), '.xdt-maker', 'browser-runtime');
