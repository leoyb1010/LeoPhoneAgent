import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parse as parseToml } from 'smol-toml';

import { convertAgents } from '../converters/agents.js';
import type { MigrationItem } from '../types.js';

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'xagent-agents-'));
});
afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

function makeItem(direction: 'to-codex' | 'to-claude', subItems: { name: string; sourcePath: string; targetPath: string }[]): MigrationItem {
  return { id: 'agents:0', kind: 'agents', direction, label: 'agents', source: '/x', target: '/y', subItems };
}

describe('convertAgents — to-codex (.md → .toml)', () => {
  it('parses YAML frontmatter and writes TOML with developer_instructions + mapped model', async () => {
    const src = path.join(tmpDir, 'foo.md');
    const dst = path.join(tmpDir, 'foo.toml');
    await fs.writeFile(
      src,
      ['---', 'name: foo', 'description: do stuff', 'tools: [Read, Write]', 'model: sonnet', '---', '', 'Body for Claude Code.', ''].join('\n'),
    );

    const r = await convertAgents(makeItem('to-codex', [{ name: 'foo', sourcePath: src, targetPath: dst }]));
    expect(r.status).toBe('success');
    const parsed = parseToml(await fs.readFile(dst, 'utf8')) as Record<string, unknown>;
    expect(parsed.name).toBe('foo');
    expect(parsed.description).toBe('do stuff');
    expect(parsed.tools).toEqual(['Read', 'Write']);
    // sonnet 是高端模型 → gpt-5.4 (top-tier)
    expect(parsed.model).toBe('gpt-5.4');
    // prompt 字段不再存在,改用 developer_instructions
    expect(parsed.prompt).toBeUndefined();
    expect(typeof parsed.developer_instructions).toBe('string');
    expect(parsed.developer_instructions as string).toContain('Codex');
    expect(parsed.developer_instructions as string).not.toContain('Claude Code');
  });

  it('haiku 模型 → gpt-5.4-mini (lightweight 档位互转)', async () => {
    const src = path.join(tmpDir, 'h.md');
    const dst = path.join(tmpDir, 'h.toml');
    await fs.writeFile(src, '---\nname: h\nmodel: claude-haiku-4-5\n---\nbody');
    await convertAgents(makeItem('to-codex', [{ name: 'h', sourcePath: src, targetPath: dst }]));
    const parsed = parseToml(await fs.readFile(dst, 'utf8')) as Record<string, unknown>;
    expect(parsed.model).toBe('gpt-5.4-mini');
  });

  it('字段重命名:reasoning_effort → model_reasoning_effort, permission_mode → sandbox_mode', async () => {
    const src = path.join(tmpDir, 'r.md');
    const dst = path.join(tmpDir, 'r.toml');
    await fs.writeFile(
      src,
      '---\nname: r\nreasoning_effort: high\npermission_mode: ask\n---\nbody',
    );
    await convertAgents(makeItem('to-codex', [{ name: 'r', sourcePath: src, targetPath: dst }]));
    const parsed = parseToml(await fs.readFile(dst, 'utf8')) as Record<string, unknown>;
    expect(parsed.model_reasoning_effort).toBe('high');
    expect(parsed.sandbox_mode).toBe('ask');
    expect(parsed.reasoning_effort).toBeUndefined();
    expect(parsed.permission_mode).toBeUndefined();
  });

  it('skips when target exists', async () => {
    const src = path.join(tmpDir, 'foo.md');
    const dst = path.join(tmpDir, 'foo.toml');
    await fs.writeFile(src, '---\nname: foo\n---\nbody');
    await fs.writeFile(dst, 'user_existing = true');
    const r = await convertAgents(makeItem('to-codex', [{ name: 'foo', sourcePath: src, targetPath: dst }]));
    expect(r.status).toBe('skipped');
    expect(await fs.readFile(dst, 'utf8')).toBe('user_existing = true');
  });

  it('skips when source has no name field', async () => {
    const src = path.join(tmpDir, 'noname.md');
    const dst = path.join(tmpDir, 'noname.toml');
    await fs.writeFile(src, '---\ndescription: x\n---\nbody');
    const r = await convertAgents(makeItem('to-codex', [{ name: 'noname', sourcePath: src, targetPath: dst }]));
    expect(r.status).toBe('skipped');
  });
});

describe('convertAgents — to-claude (.toml → .md)', () => {
  it('writes md with frontmatter and body; developer_instructions → markdown body', async () => {
    const src = path.join(tmpDir, 'foo.toml');
    const dst = path.join(tmpDir, 'foo.md');
    await fs.writeFile(src, [
      'name = "foo"',
      'description = "do stuff for Codex"',
      'model = "gpt-5.4"',
      'developer_instructions = "Body content with codex."',
      '',
    ].join('\n'));

    const r = await convertAgents(makeItem('to-claude', [{ name: 'foo', sourcePath: src, targetPath: dst }]));
    expect(r.status).toBe('success');
    const out = await fs.readFile(dst, 'utf8');
    expect(out).toMatch(/^---\n/);
    expect(out).toContain('name: foo');
    expect(out).toContain('description: do stuff for Claude code');
    // gpt-5.4 → claude top-tier
    expect(out).toContain('model: claude-opus-4-7');
    expect(out).toContain('Body content with claude code.');
    expect(out).not.toContain('developer_instructions:');
  });

  it('gpt-5.4-mini → claude-haiku-4-5', async () => {
    const src = path.join(tmpDir, 'm.toml');
    const dst = path.join(tmpDir, 'm.md');
    await fs.writeFile(src, ['name = "m"', 'model = "gpt-5.4-mini"', ''].join('\n'));
    await convertAgents(makeItem('to-claude', [{ name: 'm', sourcePath: src, targetPath: dst }]));
    const out = await fs.readFile(dst, 'utf8');
    expect(out).toContain('model: claude-haiku-4-5');
  });

  it('字段重命名反向:model_reasoning_effort → reasoning_effort, sandbox_mode → permission_mode', async () => {
    const src = path.join(tmpDir, 'r.toml');
    const dst = path.join(tmpDir, 'r.md');
    await fs.writeFile(
      src,
      ['name = "r"', 'model_reasoning_effort = "high"', 'sandbox_mode = "workspace-write"', ''].join('\n'),
    );
    await convertAgents(makeItem('to-claude', [{ name: 'r', sourcePath: src, targetPath: dst }]));
    const out = await fs.readFile(dst, 'utf8');
    expect(out).toContain('reasoning_effort: high');
    expect(out).toContain('permission_mode: workspace-write');
    expect(out).not.toContain('model_reasoning_effort:');
    expect(out).not.toContain('sandbox_mode:');
  });
});
