import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parse as parseToml } from 'smol-toml';

import { convertMcp } from '../converters/mcp.js';
import type { MigrationItem } from '../types.js';

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'xagent-mcp-'));
});
afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

function item(direction: 'to-codex' | 'to-claude', source: string, target: string): MigrationItem {
  return { id: 'mcp:0', kind: 'mcp', direction, label: 'MCP', source, target };
}

describe('convertMcp — to-codex (.mcp.json → config.toml)', () => {
  it('creates new config.toml when target missing', async () => {
    const src = path.join(tmpDir, '.mcp.json');
    const dst = path.join(tmpDir, '.codex', 'config.toml');
    await fs.writeFile(src, JSON.stringify({ mcpServers: { foo: { command: 'echo', args: ['hi'] } } }));

    const r = await convertMcp(item('to-codex', src, dst));
    expect(r.status).toBe('success');
    const parsed = parseToml(await fs.readFile(dst, 'utf8')) as Record<string, unknown>;
    const ms = parsed.mcp_servers as Record<string, { command: string }>;
    expect(ms.foo.command).toBe('echo');
  });

  it('merges into existing config.toml without overwriting existing keys', async () => {
    const src = path.join(tmpDir, '.mcp.json');
    const dst = path.join(tmpDir, '.codex', 'config.toml');
    await fs.mkdir(path.dirname(dst), { recursive: true });
    await fs.writeFile(src, JSON.stringify({
      mcpServers: { newOne: { command: 'a' }, existing: { command: 'b' } },
    }));
    await fs.writeFile(dst, '[mcp_servers.existing]\ncommand = "user-original"\n');

    const r = await convertMcp(item('to-codex', src, dst));
    expect(r.status).toBe('success');
    const parsed = parseToml(await fs.readFile(dst, 'utf8')) as Record<string, unknown>;
    const ms = parsed.mcp_servers as Record<string, { command: string }>;
    expect(ms.newOne.command).toBe('a');
    expect(ms.existing.command).toBe('user-original'); // 不覆盖
  });

  it('skips disabled servers', async () => {
    const src = path.join(tmpDir, '.mcp.json');
    const dst = path.join(tmpDir, '.codex', 'config.toml');
    await fs.writeFile(src, JSON.stringify({
      mcpServers: { off: { command: 'x', disabled: true }, on: { command: 'y' } },
    }));
    const r = await convertMcp(item('to-codex', src, dst));
    expect(r.status).toBe('success');
    const parsed = parseToml(await fs.readFile(dst, 'utf8')) as Record<string, unknown>;
    const ms = parsed.mcp_servers as Record<string, unknown>;
    expect('on' in ms).toBe(true);
    expect('off' in ms).toBe(false);
  });

  it('skipped when source has no mcpServers', async () => {
    const src = path.join(tmpDir, '.mcp.json');
    await fs.writeFile(src, JSON.stringify({ otherStuff: true }));
    const r = await convertMcp(item('to-codex', src, path.join(tmpDir, 'config.toml')));
    expect(r.status).toBe('skipped');
  });
});

describe('convertMcp — to-claude (config.toml → .mcp.json)', () => {
  it('creates new .mcp.json from TOML', async () => {
    const src = path.join(tmpDir, '.codex', 'config.toml');
    const dst = path.join(tmpDir, '.mcp.json');
    await fs.mkdir(path.dirname(src), { recursive: true });
    await fs.writeFile(src, '[mcp_servers.foo]\ncommand = "echo"\nargs = ["hi"]\n');

    const r = await convertMcp(item('to-claude', src, dst));
    expect(r.status).toBe('success');
    const json = JSON.parse(await fs.readFile(dst, 'utf8'));
    expect(json.mcpServers.foo.command).toBe('echo');
  });

  it('merges into existing .mcp.json without overwriting', async () => {
    const src = path.join(tmpDir, '.codex', 'config.toml');
    const dst = path.join(tmpDir, '.mcp.json');
    await fs.mkdir(path.dirname(src), { recursive: true });
    await fs.writeFile(src, '[mcp_servers.fresh]\ncommand = "a"\n[mcp_servers.existing]\ncommand = "from-codex"\n');
    await fs.writeFile(dst, JSON.stringify({ mcpServers: { existing: { command: 'user-kept' } } }));

    const r = await convertMcp(item('to-claude', src, dst));
    expect(r.status).toBe('success');
    const json = JSON.parse(await fs.readFile(dst, 'utf8'));
    expect(json.mcpServers.existing.command).toBe('user-kept');
    expect(json.mcpServers.fresh.command).toBe('a');
  });
});
