/**
 * Phase 4.1 unit tests — parser logic for cc-manager probe output.
 *
 * Full install flow (SSH upload + verify) requires a live SSH host, so it's
 * verified manually + via integration tests in the desktop app. Here we just
 * test the pure parser against representative probe stdout shapes.
 */

import { describe, expect, it } from 'vitest';

import { buildUploadScript, parseProbeOutput } from '../bootstrap/cc-manager-installer.js';

describe('cc-manager installer parser', () => {
  it('parses a fully-installed state (node + mgr + proxy)', () => {
    const stdout = [
      'INSTALL_DIR /home/builder/.xdt-server/v1',
      'NODE_BIN /home/builder/.xdt-server/v1/node/bin/node',
      'MGR_BIN /home/builder/.xdt-server/v1/cc-manager/cc-mgr.mjs',
      'PROXY_BIN /home/builder/.xdt-server/v1/cc-manager/proxy.mjs',
      'NODE_READY 22.13.0',
      'MGR_READY {"managerVersion":"0.0.0","protocolVersion":1}',
      'PROXY_READY {"version":"0.0.0"}',
    ].join('\n');
    const r = parseProbeOutput(stdout);
    expect(r.nodeReady).toBe(true);
    expect(r.ccManagerInstalled).toBe(true);
    expect(r.ccManagerProtocolVersion).toBe(1);
    expect(r.ccManagerVersion).toBe('0.0.0');
    expect(r.proxyInstalled).toBe(true);
    expect(r.installDir).toBe('/home/builder/.xdt-server/v1');
    expect(r.nodeBinaryPath).toBe('/home/builder/.xdt-server/v1/node/bin/node');
    expect(r.ccManagerBinaryPath).toBe('/home/builder/.xdt-server/v1/cc-manager/cc-mgr.mjs');
    expect(r.proxyBinaryPath).toBe('/home/builder/.xdt-server/v1/cc-manager/proxy.mjs');
  });

  it('parses node-missing state', () => {
    const stdout = [
      'INSTALL_DIR /home/x/.xdt-server/v1',
      'NODE_BIN /home/x/.xdt-server/v1/node/bin/node',
      'MGR_BIN /home/x/.xdt-server/v1/cc-manager/cc-mgr.mjs',
      'PROXY_BIN /home/x/.xdt-server/v1/cc-manager/proxy.mjs',
      'NODE_MISSING',
      'MGR_MISSING',
      'PROXY_MISSING',
    ].join('\n');
    const r = parseProbeOutput(stdout);
    expect(r.nodeReady).toBe(false);
    expect(r.ccManagerInstalled).toBe(false);
    expect(r.proxyInstalled).toBe(false);
  });

  it('parses node-ready + mgr-missing (typical pre-install state)', () => {
    const stdout = [
      'INSTALL_DIR /home/x/.xdt-server/v1',
      'NODE_BIN /home/x/.xdt-server/v1/node/bin/node',
      'MGR_BIN /home/x/.xdt-server/v1/cc-manager/cc-mgr.mjs',
      'PROXY_BIN /home/x/.xdt-server/v1/cc-manager/proxy.mjs',
      'NODE_READY 22.13.0',
      'MGR_MISSING',
      'PROXY_MISSING',
    ].join('\n');
    const r = parseProbeOutput(stdout);
    expect(r.nodeReady).toBe(true);
    expect(r.ccManagerInstalled).toBe(false);
    expect(r.proxyInstalled).toBe(false);
    expect(r.ccManagerBinaryPath).toBe('/home/x/.xdt-server/v1/cc-manager/cc-mgr.mjs');
  });

  it('handles malformed mgr version JSON gracefully', () => {
    const stdout = [
      'INSTALL_DIR /home/x/.xdt-server/v1',
      'NODE_BIN /home/x/.xdt-server/v1/node/bin/node',
      'MGR_BIN /home/x/.xdt-server/v1/cc-manager/cc-mgr.mjs',
      'PROXY_BIN /home/x/.xdt-server/v1/cc-manager/proxy.mjs',
      'NODE_READY 22.13.0',
      'MGR_READY this is not json',
      'PROXY_MISSING',
    ].join('\n');
    const r = parseProbeOutput(stdout);
    expect(r.nodeReady).toBe(true);
    expect(r.ccManagerInstalled).toBe(false);
    expect(r.ccManagerVersion).toBeNull();
    expect(r.ccManagerProtocolVersion).toBeNull();
  });

  it('handles missing INSTALL_DIR (falls back to default)', () => {
    const stdout = ['NODE_MISSING', 'MGR_MISSING', 'PROXY_MISSING'].join('\n');
    const r = parseProbeOutput(stdout);
    expect(r.installDir).toBe('$HOME/.xdt-server/v1');
    expect(r.ccManagerBinaryPath).toContain('cc-manager/cc-mgr.mjs');
  });

  it('tolerates CRLF line endings', () => {
    const stdout = [
      'INSTALL_DIR /home/x/.xdt-server/v1',
      'NODE_BIN /home/x/.xdt-server/v1/node/bin/node',
      'MGR_BIN /home/x/.xdt-server/v1/cc-manager/cc-mgr.mjs',
      'PROXY_BIN /home/x/.xdt-server/v1/cc-manager/proxy.mjs',
      'NODE_READY 22.13.0',
      'MGR_READY {"managerVersion":"0.0.0","protocolVersion":1}',
      'PROXY_MISSING',
    ].join('\r\n');
    const r = parseProbeOutput(stdout);
    expect(r.nodeReady).toBe(true);
    expect(r.ccManagerInstalled).toBe(true);
  });

  it('expands $HOME paths when building upload script', () => {
    const script = buildUploadScript('$HOME/.xdt-server/v1/cc-manager/cc-mgr.mjs');
    expect(script).toContain('REMOTE_PATH="$HOME/${REMOTE_PATH#\\$HOME/}"');
    expect(script).toContain('cat > "$REMOTE_PATH"');
    expect(script).not.toContain("cat > '$HOME/");
  });
});
