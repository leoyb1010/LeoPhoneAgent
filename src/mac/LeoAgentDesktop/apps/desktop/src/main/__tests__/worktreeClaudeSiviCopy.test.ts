import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

import { copyClaudeSiviDirs } from '../worktree/WorktreeManager';

describe('copyClaudeSiviDirs', () => {
  let tmpRoot: string;
  let baseRepo: string;
  let worktreePath: string;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xdt-wt-claude-copy-'));
    baseRepo = path.join(tmpRoot, 'repo');
    worktreePath = path.join(tmpRoot, 'repo', '.xdt-worktrees', 'auto-test');

    fs.mkdirSync(path.join(baseRepo, '.claude', 'skills', 'demo'), { recursive: true });
    fs.mkdirSync(path.join(baseRepo, '.claude', 'rules'), { recursive: true });
    fs.mkdirSync(path.join(baseRepo, '.claude', 'worktrees', 'old-session'), { recursive: true });
    fs.mkdirSync(path.join(baseRepo, '.sivi', 'souls'), { recursive: true });

    fs.writeFileSync(path.join(baseRepo, '.claude', 'settings.json'), '{}');
    fs.writeFileSync(path.join(baseRepo, '.claude', 'skills', 'demo', 'SKILL.md'), '# demo');
    fs.writeFileSync(path.join(baseRepo, '.claude', 'rules', 'project.md'), '# project');
    fs.writeFileSync(path.join(baseRepo, '.claude', 'worktrees', 'old-session', 'state.json'), '{}');
    fs.writeFileSync(path.join(baseRepo, '.sivi', 'souls', 'main.json'), '{}');
  });

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('copies project config but skips Claude worktree history', async () => {
    await copyClaudeSiviDirs(baseRepo, worktreePath);

    expect(fs.existsSync(path.join(worktreePath, '.claude', 'settings.json'))).toBe(true);
    expect(fs.existsSync(path.join(worktreePath, '.claude', 'skills', 'demo', 'SKILL.md'))).toBe(true);
    expect(fs.existsSync(path.join(worktreePath, '.claude', 'rules', 'project.md'))).toBe(true);
    expect(fs.existsSync(path.join(worktreePath, '.sivi', 'souls', 'main.json'))).toBe(true);

    expect(fs.existsSync(path.join(worktreePath, '.claude', 'worktrees'))).toBe(false);
  });

  it('restore mode preserves snapshot files while copying missing config', async () => {
    fs.mkdirSync(path.join(worktreePath, '.claude'), { recursive: true });
    fs.mkdirSync(path.join(worktreePath, '.sivi', 'souls'), { recursive: true });
    fs.writeFileSync(path.join(worktreePath, '.claude', 'settings.json'), '{"snapshot":true}');
    fs.writeFileSync(path.join(worktreePath, '.sivi', 'souls', 'main.json'), '{"snapshot":true}');

    await copyClaudeSiviDirs(baseRepo, worktreePath, { overwriteExisting: false });

    expect(fs.readFileSync(path.join(worktreePath, '.claude', 'settings.json'), 'utf8')).toBe(
      '{"snapshot":true}',
    );
    expect(fs.readFileSync(path.join(worktreePath, '.sivi', 'souls', 'main.json'), 'utf8')).toBe(
      '{"snapshot":true}',
    );
    expect(fs.existsSync(path.join(worktreePath, '.claude', 'skills', 'demo', 'SKILL.md'))).toBe(
      true,
    );
  });
});
