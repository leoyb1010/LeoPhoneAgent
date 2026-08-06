/**
 * cc-manager remote install — separate path from `installRemoteAgent` because
 * cc-manager isn't an npm package. It's a single esbuild-bundled .mjs file
 * (~956KB, includes the @anthropic-ai/claude-agent-sdk) that we ship to the
 * remote via SSH.
 *
 * Install layout (mirrors the bundled-node convention from installer.ts):
 *   ~/.xdt-server/v1/cc-manager/cc-mgr.mjs   (the bundle)
 *   ~/.xdt-server/v1/cc-manager/.installed   (sentinel)
 *
 * Node runtime: we REUSE the bundled node from `~/.xdt-server/v1/node/`
 * installed by the standard agent bootstrap. cc-manager probe / install
 * therefore requires the bundled node to already be present — typically
 * by installing claude-code or codex first. (Phase 7 may add a dedicated
 * "ensure node only" path so cc-manager works standalone.)
 *
 * Optional second binary: `proxy.mjs` (anthropic-compat-proxy CLI, ~14KB).
 * Installed alongside cc-mgr when `compatProxyMode='on'`. cc-manager spawns
 * it on demand at session start.
 */

import * as fs from 'node:fs/promises';
import type { RemoteHost } from '../RemoteHost.js';

export interface CcManagerProbeResult {
  /** bundled node is present + runnable. */
  nodeReady: boolean;
  /** cc-mgr.mjs exists + `--version` returns valid JSON with protocolVersion. */
  ccManagerInstalled: boolean;
  /** Protocol version reported by the installed cc-mgr (matches client's PROTOCOL_VERSION when in sync). */
  ccManagerProtocolVersion: number | null;
  /** Manager version (semver-like). */
  ccManagerVersion: string | null;
  /** Optional companion: proxy.mjs installed + runnable. */
  proxyInstalled: boolean;
  /** Absolute remote path of cc-mgr.mjs (computed even if not installed). */
  ccManagerBinaryPath: string;
  /** Absolute remote path of proxy.mjs. */
  proxyBinaryPath: string;
  /** Bundled-node binary path (we depend on it). */
  nodeBinaryPath: string;
  /** Install root: $HOME/.xdt-server/<schema-version> resolved by remote bash. */
  installDir: string;
}

export type CcManagerInstallProgress =
  | { kind: 'probe' }
  | { kind: 'install-start'; what: 'cc-manager' | 'proxy' }
  | { kind: 'install-upload'; bytes: number; what: 'cc-manager' | 'proxy' }
  | { kind: 'install-done'; what: 'cc-manager' | 'proxy' }
  | { kind: 'ready' }
  | { kind: 'error'; message: string };

export type CcManagerInstallEventCallback = (event: CcManagerInstallProgress) => void;

/**
 * Probe remote state: bundled node ready? cc-mgr.mjs installed? proxy.mjs installed?
 *
 * Doesn't change anything. Caller decides whether to install based on the result.
 */
export async function probeCcManager(host: RemoteHost): Promise<CcManagerProbeResult> {
  // POSIX bash. $1 = serverVersion (matches REMOTE_SERVER_SCHEMA_VERSION).
  const script = String.raw`#!/usr/bin/env bash
set -u
SERVER_VER="${'$'}{1:-v1}"
INSTALL_DIR="$HOME/.xdt-server/$SERVER_VER"
NODE_BIN="$INSTALL_DIR/node/bin/node"
MGR_DIR="$INSTALL_DIR/cc-manager"
MGR_BIN="$MGR_DIR/cc-mgr.mjs"
PROXY_BIN="$MGR_DIR/proxy.mjs"

mkdir -p "$INSTALL_DIR" "$MGR_DIR" && chmod 700 "$INSTALL_DIR" "$MGR_DIR"
printf 'INSTALL_DIR %s\n' "$INSTALL_DIR"
printf 'NODE_BIN %s\n' "$NODE_BIN"
printf 'MGR_BIN %s\n' "$MGR_BIN"
printf 'PROXY_BIN %s\n' "$PROXY_BIN"

# Bundled node?
if [ -x "$NODE_BIN" ]; then
  V="$("$NODE_BIN" -p 'process.versions.node' 2>/dev/null || true)"
  if [ -n "$V" ]; then printf 'NODE_READY %s\n' "$V"; fi
else
  printf 'NODE_MISSING\n'
fi

# cc-manager?
if [ -f "$MGR_BIN" ]; then
  # cc-mgr.mjs --version emits one JSON line: {"managerVersion":"x.x.x","protocolVersion":N}
  V="$("$NODE_BIN" "$MGR_BIN" --version 2>/dev/null || true)"
  if [ -n "$V" ]; then printf 'MGR_READY %s\n' "$V"; fi
else
  printf 'MGR_MISSING\n'
fi

# proxy?
if [ -f "$PROXY_BIN" ]; then
  V="$("$NODE_BIN" "$PROXY_BIN" --version 2>/dev/null || true)"
  if [ -n "$V" ]; then printf 'PROXY_READY %s\n' "$V"; fi
else
  printf 'PROXY_MISSING\n'
fi
exit 0
`;
  // Pass SERVER_VER as arg (matches REMOTE_SERVER_SCHEMA_VERSION constant).
  const result = await host.exec(
    `bash -l -s -- v1`,
    {
      input: script,
      timeoutMs: 15_000,
      label: 'cc-manager-probe',
    },
  );

  return parseProbeOutput(result.stdout);
}

/**
 * Install (or update) cc-manager bundle on the remote. Uploads via SSH cat
 * with stdin pipe (no SFTP dependency).
 *
 * Caller must provide local absolute path to dist/cc-mgr.mjs. Optional
 * `proxyBundlePath` installs the anthropic-compat-proxy companion.
 *
 * Idempotent — overwrites whatever is there. Sentinel is implicit (cc-mgr.mjs
 * presence + --version success).
 */
export async function installCcManagerBundle(
  host: RemoteHost,
  opts: {
    ccManagerBundlePath: string;
    /** When present, also install proxy.mjs at the same time. */
    proxyBundlePath?: string;
    onEvent?: CcManagerInstallEventCallback;
  },
): Promise<{ ready: boolean; error?: string; probe: CcManagerProbeResult }> {
  const onEvent = opts.onEvent ?? ((): void => undefined);
  onEvent({ kind: 'probe' });

  // Step 1: probe — make sure node is there. If not, abort (require bootstrap first).
  const probe1 = await probeCcManager(host);
  if (!probe1.nodeReady) {
    const msg =
      'bundled node not installed on remote — run installRemoteAgent("claude-code" or "codex") first to bootstrap node';
    onEvent({ kind: 'error', message: msg });
    return { ready: false, error: msg, probe: probe1 };
  }

  // Step 2: upload cc-mgr.mjs.
  onEvent({ kind: 'install-start', what: 'cc-manager' });
  const ccMgrBytes = await fs.readFile(opts.ccManagerBundlePath);
  onEvent({ kind: 'install-upload', bytes: ccMgrBytes.length, what: 'cc-manager' });
  try {
    await uploadBundle(host, ccMgrBytes, probe1.ccManagerBinaryPath);
  } catch (err) {
    const msg = `failed to upload cc-mgr.mjs: ${(err as Error).message}`;
    onEvent({ kind: 'error', message: msg });
    return { ready: false, error: msg, probe: probe1 };
  }
  onEvent({ kind: 'install-done', what: 'cc-manager' });

  // Step 3: optional proxy upload.
  if (opts.proxyBundlePath) {
    onEvent({ kind: 'install-start', what: 'proxy' });
    const proxyBytes = await fs.readFile(opts.proxyBundlePath);
    onEvent({ kind: 'install-upload', bytes: proxyBytes.length, what: 'proxy' });
    try {
      await uploadBundle(host, proxyBytes, probe1.proxyBinaryPath);
    } catch (err) {
      const msg = `failed to upload proxy.mjs: ${(err as Error).message}`;
      onEvent({ kind: 'error', message: msg });
      return { ready: false, error: msg, probe: probe1 };
    }
    onEvent({ kind: 'install-done', what: 'proxy' });
  }

  // Step 4: verify (re-probe).
  const probe2 = await probeCcManager(host);
  if (!probe2.ccManagerInstalled) {
    const msg = `cc-mgr installed but --version probe failed (uploaded ${ccMgrBytes.length} bytes; check node ${probe2.nodeBinaryPath})`;
    onEvent({ kind: 'error', message: msg });
    return { ready: false, error: msg, probe: probe2 };
  }

  onEvent({ kind: 'ready' });
  return { ready: true, probe: probe2 };
}

/**
 * Uninstall cc-manager (rm cc-manager/ dir). Idempotent.
 */
export async function uninstallCcManager(host: RemoteHost): Promise<void> {
  await host.exec(
    `bash -c 'rm -rf "$HOME/.xdt-server/v1/cc-manager"'`,
    { timeoutMs: 10_000, label: 'cc-manager-uninstall' },
  );
}

/* ============================== private ============================== */

/**
 * Upload bytes to a remote path using SSH stdin pipe.
 *
 * `cat > path` reads stdin until EOF then writes to file. Binary-safe.
 * We chmod 644 after upload (read by owner, no execute bit needed —
 * cc-mgr.mjs is invoked as `node cc-mgr.mjs args`, not as an executable).
 *
 * Path is shell-quoted defensively (handles spaces / quotes in $HOME, rare
 * but seen on some macOS user dirs).
 */
async function uploadBundle(host: RemoteHost, bytes: Buffer, remotePath: string): Promise<void> {
  // Make sure parent dir exists. The remotePath contains $HOME shell vars
  // (e.g. "$HOME/.xdt-server/v1/cc-manager/cc-mgr.mjs"), so we need a shell
  // to expand them; we cat into that location.
  const script = buildUploadScript(remotePath);
  const result = await host.exec(`bash -c ${shellQuote(script)}`, {
    input: bytes,
    timeoutMs: 60_000,
    label: 'cc-manager-upload',
  });
  if (result.exitCode !== 0) {
    throw new Error(
      `remote bash exit=${result.exitCode}: ${result.stderr.trim().slice(0, 200) || '(no stderr)'}`,
    );
  }
}

export function buildUploadScript(remotePath: string): string {
  return [
    `REMOTE_PATH=${shellQuote(remotePath)}`,
    `case "$REMOTE_PATH" in`,
    `  '$HOME'/*) REMOTE_PATH="$HOME/\${REMOTE_PATH#\\$HOME/}" ;;`,
    `esac`,
    `mkdir -p "$(dirname "$REMOTE_PATH")" && cat > "$REMOTE_PATH" && chmod 644 "$REMOTE_PATH"`,
  ].join('\n');
}

/**
 * Quote a string for POSIX sh single-quoted form. Embedded single quotes are
 * closed, escaped, and reopened: foo'bar → 'foo'\''bar'.
 */
function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * Parse probe stdout. Format:
 *   INSTALL_DIR /home/x/.xdt-server/v1
 *   NODE_BIN /home/x/.xdt-server/v1/node/bin/node
 *   MGR_BIN /home/x/.xdt-server/v1/cc-manager/cc-mgr.mjs
 *   PROXY_BIN /home/x/.xdt-server/v1/cc-manager/proxy.mjs
 *   NODE_READY 22.13.0
 *   MGR_READY {"managerVersion":"0.0.0","protocolVersion":1}
 *   PROXY_READY {"version":"0.0.0"}
 *
 * Lines with MISSING variants for any of the above are absences.
 */
export function parseProbeOutput(stdout: string): CcManagerProbeResult {
  const lines = stdout.split(/\r?\n/);
  const get = (prefix: string): string | null => {
    for (const line of lines) {
      if (line.startsWith(prefix + ' ')) {
        return line.slice(prefix.length + 1).trim();
      }
      if (line === prefix) return ''; // for MISSING-style flags
    }
    return null;
  };

  const installDir = get('INSTALL_DIR') ?? '$HOME/.xdt-server/v1';
  const nodeBinaryPath = get('NODE_BIN') ?? `${installDir}/node/bin/node`;
  const ccManagerBinaryPath = get('MGR_BIN') ?? `${installDir}/cc-manager/cc-mgr.mjs`;
  const proxyBinaryPath = get('PROXY_BIN') ?? `${installDir}/cc-manager/proxy.mjs`;

  const nodeReady = get('NODE_READY') !== null;
  const mgrReadyRaw = get('MGR_READY');
  const proxyReadyRaw = get('PROXY_READY');

  let ccManagerProtocolVersion: number | null = null;
  let ccManagerVersion: string | null = null;
  let ccManagerInstalled = false;
  if (mgrReadyRaw) {
    try {
      const j = JSON.parse(mgrReadyRaw) as { managerVersion?: string; protocolVersion?: number };
      ccManagerVersion = j.managerVersion ?? null;
      ccManagerProtocolVersion = typeof j.protocolVersion === 'number' ? j.protocolVersion : null;
      ccManagerInstalled = ccManagerProtocolVersion !== null;
    } catch {
      ccManagerInstalled = false;
    }
  }

  const proxyInstalled = proxyReadyRaw !== null && proxyReadyRaw.length > 0;

  return {
    nodeReady,
    ccManagerInstalled,
    ccManagerProtocolVersion,
    ccManagerVersion,
    proxyInstalled,
    ccManagerBinaryPath,
    proxyBinaryPath,
    nodeBinaryPath,
    installDir,
  };
}
