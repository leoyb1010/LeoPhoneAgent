import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { convertAll } from '../converter.js';
import { rewriteTerms } from '../converters/term-rewrite.js';
import type { MigrationItem, MigrationStepEvent } from '../types.js';

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'xagent-conv-'));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe('rewriteTerms', () => {
  it('to-codex: claude code → codex (preserves case)', () => {
    expect(rewriteTerms('use Claude Code today', 'to-codex')).toBe('use Codex today');
    expect(rewriteTerms('use claude code today', 'to-codex')).toBe('use codex today');
  });

  it('to-codex: variants (claude-code / claude_code / claudecode / claude)', () => {
    expect(rewriteTerms('claude-code rocks', 'to-codex')).toBe('codex rocks');
    expect(rewriteTerms('claude_code rocks', 'to-codex')).toBe('codex rocks');
    expect(rewriteTerms('claudecode rocks', 'to-codex')).toBe('codex rocks');
    expect(rewriteTerms('claude rocks', 'to-codex')).toBe('codex rocks');
  });

  it('to-codex: 单词边界保护 (myclaude123 / claudette 不变)', () => {
    expect(rewriteTerms('myclaude123 stays', 'to-codex')).toBe('myclaude123 stays');
    expect(rewriteTerms('claudette stays', 'to-codex')).toBe('claudette stays');
  });

  it('to-codex: 优先匹配最长 (claude code > claude)', () => {
    expect(rewriteTerms('claude code only', 'to-codex')).toBe('codex only');
  });

  it('to-claude: codex → claude code (preserves case, word boundary)', () => {
    expect(rewriteTerms('use Codex today', 'to-claude')).toBe('use Claude code today');
    expect(rewriteTerms('mycodex123 stays', 'to-claude')).toBe('mycodex123 stays');
  });
});

describe('convertAll — agents-md kind', () => {
  it('emits running → success and writes target', async () => {
    const src = path.join(tmpDir, 'CLAUDE.md');
    const dst = path.join(tmpDir, 'AGENTS.md');
    await fs.writeFile(src, '# Claude Code Project\n\nUse claude for tasks.');
    const item: MigrationItem = {
      id: 'agents-md:0',
      kind: 'agents-md',
      direction: 'to-codex',
      label: 'CLAUDE.md → AGENTS.md',
      source: src,
      target: dst,
    };
    const events: MigrationStepEvent[] = [];
    const summary = await convertAll([item], (ev) => events.push(ev));

    expect(events.map((e) => e.status)).toEqual(['running', 'success']);
    expect(summary).toEqual({ total: 1, successCount: 1, skippedCount: 0, failedCount: 0 });
    expect(await fs.readFile(dst, 'utf8')).toBe('# Codex Project\n\nUse codex for tasks.');
  });

  it('target already exists at convert time → skipped, NOT failed, original target untouched', async () => {
    const src = path.join(tmpDir, 'CLAUDE.md');
    const dst = path.join(tmpDir, 'AGENTS.md');
    await fs.writeFile(src, '# x');
    await fs.writeFile(dst, '# user existing content');
    const item: MigrationItem = {
      id: 'agents-md:0',
      kind: 'agents-md',
      direction: 'to-codex',
      label: 'X',
      source: src,
      target: dst,
    };
    const events: MigrationStepEvent[] = [];
    const summary = await convertAll([item], (ev) => events.push(ev));

    expect(events[1].status).toBe('skipped');
    expect(summary.skippedCount).toBe(1);
    expect(await fs.readFile(dst, 'utf8')).toBe('# user existing content');
  });

  it('source missing → failed, summary.failedCount=1', async () => {
    const item: MigrationItem = {
      id: 'agents-md:0',
      kind: 'agents-md',
      direction: 'to-codex',
      label: 'X',
      source: path.join(tmpDir, 'nope.md'),
      target: path.join(tmpDir, 'AGENTS.md'),
    };
    const events: MigrationStepEvent[] = [];
    const summary = await convertAll([item], (ev) => events.push(ev));

    expect(events[1].status).toBe('failed');
    expect(summary.failedCount).toBe(1);
  });

  it('多项串行：一项失败不阻塞其他项', async () => {
    const src1 = path.join(tmpDir, 'AGENTS.md');
    const dst1 = path.join(tmpDir, 'CLAUDE.md');
    await fs.writeFile(src1, '# good');

    const items: MigrationItem[] = [
      {
        id: 'agents-md:0',
        kind: 'agents-md',
        direction: 'to-claude',
        label: 'A',
        source: src1,
        target: dst1,
      },
      {
        id: 'agents-md:1',
        kind: 'agents-md',
        direction: 'to-claude',
        label: 'B (will fail)',
        source: path.join(tmpDir, 'gone.md'),
        target: path.join(tmpDir, 'B.md'),
      },
    ];
    const events: MigrationStepEvent[] = [];
    const summary = await convertAll(items, (ev) => events.push(ev));

    expect(summary).toEqual({ total: 2, successCount: 1, skippedCount: 0, failedCount: 1 });
  });

  it('callback fires per step in order', async () => {
    const src = path.join(tmpDir, 'CLAUDE.md');
    const dst = path.join(tmpDir, 'AGENTS.md');
    await fs.writeFile(src, '# x');
    const cb = vi.fn();
    await convertAll(
      [
        {
          id: 'i1',
          kind: 'agents-md',
          direction: 'to-codex',
          label: 'X',
          source: src,
          target: dst,
        },
      ],
      cb,
    );
    expect(cb).toHaveBeenCalledTimes(2);
    expect(cb.mock.calls[0][0].status).toBe('running');
    expect(cb.mock.calls[1][0].status).toBe('success');
  });
});
