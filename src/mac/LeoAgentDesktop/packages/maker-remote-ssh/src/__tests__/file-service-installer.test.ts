/**
 * file-service-installer probe 输出解析单测(与 cc-manager-installer.test 同款
 * 口径:纯 parse,不碰真实 SSH)。
 */

import { describe, expect, it } from 'vitest';

import { parseFileServiceProbeOutput } from '../bootstrap/file-service-installer.js';

describe('parseFileServiceProbeOutput', () => {
  it('parses a fully-installed remote', () => {
    const out = parseFileServiceProbeOutput(
      [
        'NODE_BIN /home/u/.xdt-server/v1/node/bin/node',
        'FS_BIN /home/u/.xdt-server/v1/file-service/file-service.mjs',
        'NODE_READY 22.13.0',
        'FS_READY {"bundleVersion":"0.1.0","schemaVersion":1}',
        'RG_PATH /usr/bin/rg',
      ].join('\n'),
    );
    expect(out.nodeReady).toBe(true);
    expect(out.installed).toBe(true);
    expect(out.schemaVersion).toBe(1);
    expect(out.bundleVersion).toBe('0.1.0');
    expect(out.binaryPath).toBe('/home/u/.xdt-server/v1/file-service/file-service.mjs');
    expect(out.rgPath).toBe('/usr/bin/rg');
  });

  it('parses node-ready but service missing', () => {
    const out = parseFileServiceProbeOutput(
      ['NODE_BIN /home/u/n', 'FS_BIN /home/u/f', 'NODE_READY 22.13.0', 'FS_MISSING'].join('\n'),
    );
    expect(out.nodeReady).toBe(true);
    expect(out.installed).toBe(false);
    expect(out.schemaVersion).toBeNull();
    expect(out.rgPath).toBeNull();
  });

  it('parses node missing', () => {
    const out = parseFileServiceProbeOutput(
      ['NODE_BIN /home/u/n', 'FS_BIN /home/u/f', 'NODE_MISSING', 'FS_MISSING'].join('\n'),
    );
    expect(out.nodeReady).toBe(false);
    expect(out.installed).toBe(false);
  });

  it('treats corrupt --version JSON as not installed', () => {
    const out = parseFileServiceProbeOutput(
      ['NODE_BIN /n', 'FS_BIN /f', 'NODE_READY 22.13.0', 'FS_READY garbage-not-json'].join('\n'),
    );
    expect(out.installed).toBe(false);
    expect(out.bundleVersion).toBeNull();
  });
});
