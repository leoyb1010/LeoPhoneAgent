/**
 * Public wire/data types for @cindy/maker-remote-ssh.
 *
 * Kept narrow on purpose — Phase A only covers connection management.
 * Channel / exec / sftp types will live alongside their impls when added.
 */

export type RemoteStatus =
  | 'disconnected'
  | 'connecting'
  | 'authenticating'
  | 'ready'
  | 'reconnecting'
  | 'failed';

export type AuthMethod = 'agent' | 'key';

/**
 * Source of truth for a host entry. `ssh-config` = parsed from
 * `~/.ssh/config`; `manual` = added via maker UI (also written back to
 * `~/.ssh/config` so terminal `ssh <alias>` keeps working).
 */
export type HostSource = 'ssh-config' | 'manual';

/**
 * One remote machine known to maker. `id` doubles as the SSH alias
 * (the `Host <id>` line in ~/.ssh/config) — they must match so that
 * round-tripping through the config file is lossless.
 */
export interface HostConfig {
  /** alias / unique key. Also the `Host` directive in ~/.ssh/config. */
  id: string;
  hostname: string;
  port: number;
  user: string;
  authMethod: AuthMethod;
  /** absolute path; only meaningful when authMethod === 'key'. */
  identityFile?: string;
  source: HostSource;
}

/** Snapshot of a host's runtime state for renderer. */
export interface HostSnapshot {
  config: HostConfig;
  status: RemoteStatus;
  lastError?: string;
  /**
   * Human-readable label for the credential that succeeded on the most
   * recent connect — e.g. "ssh-agent" or "key:id_ed25519". Undefined when
   * the host has never connected. UI surfaces this so the user can tell
   * whether their configured identityFile actually got used, or the
   * connection went through ssh-agent instead.
   */
  lastAuthLabel?: string;
  /** wall-clock ms when status last changed; renderer uses for "X s ago". */
  statusChangedAt: number;
}

export interface AddHostInput {
  id: string;
  hostname: string;
  port?: number;
  user: string;
  authMethod?: AuthMethod;
  identityFile?: string;
}
