/**
 * pathDerivations.test.ts — renderer deriveScope / deriveProjectWorkingDir 单测
 *
 * Fixture set mirrors `src/main/skillhub/registry/__tests__/derivations.test.ts`
 * so the renderer and main implementations stay byte-equal.
 *
 * Note: renderer cannot use `node:os` or `node:path` so we test with literal
 * paths that cover both POSIX and Windows patterns.
 */
import { describe, it, expect } from 'vitest';

import { deriveScope, deriveProjectWorkingDir } from '../pathDerivations';

// ── POSIX fixtures ────────────────────────────────────────────────────────────

describe('deriveScope (POSIX)', () => {
  it('global skill path → global', () => {
    expect(deriveScope('/home/sam/.claude/skills/my-skill')).toBe('global');
  });

  it('global skill macOS home → global', () => {
    expect(deriveScope('/Users/sam/.claude/skills/my-skill')).toBe('global');
  });

  it('project skill path → project', () => {
    expect(deriveScope('/Users/sam/projects/foo/.claude/skills/my-skill')).toBe('project');
  });

  it('unrelated path → project', () => {
    expect(deriveScope('/some/random/path')).toBe('project');
  });

  it('path like global but without .claude → project', () => {
    expect(deriveScope('/home/sam/skills/my-skill')).toBe('project');
  });

  it('path with .claude but no skills → project', () => {
    expect(deriveScope('/home/sam/.claude/commands/my-cmd')).toBe('project');
  });

  it('nested global subdir → global', () => {
    // path inside a skill dir is still "global" (same as main implementation)
    expect(deriveScope('/home/sam/.claude/skills/my-skill/subdir')).toBe('global');
  });
});

describe('deriveScope (Windows)', () => {
  it('global skill Windows path → global', () => {
    expect(deriveScope('C:\\Users\\sam\\.claude\\skills\\my-skill')).toBe('global');
  });

  it('project skill Windows path → project', () => {
    expect(deriveScope('C:\\work\\myrepo\\.claude\\skills\\awesome-skill')).toBe('project');
  });

  it('mixed separators Windows → global', () => {
    // forward slashes in a Windows-style path (drive letter present)
    expect(deriveScope('C:/Users/sam/.claude/skills/my-skill')).toBe('global');
  });
});

// ── deriveScope — known edge cases (non-standard home directories) ────────────
// These cases document accepted divergence between renderer deriveScope
// (structural depth) and main-process derivations.ts (os.homedir() comparison).

describe('deriveScope — non-standard home path edge cases', () => {
  it('deep POSIX home /opt/users/sam → classified as project (known limitation)', () => {
    // Actual home is /opt/users/sam but depth > 2, so renderer cannot detect
    // it as global. main-process would correctly return global via os.homedir().
    expect(deriveScope('/opt/users/sam/.claude/skills/my-skill')).toBe('project');
  });

  it('depth-3 home /data/home/sam → classified as project (known limitation)', () => {
    expect(deriveScope('/data/home/sam/.claude/skills/my-skill')).toBe('project');
  });
});

// ── deriveProjectWorkingDir ───────────────────────────────────────────────────

describe('deriveProjectWorkingDir (POSIX)', () => {
  it('global skill → null', () => {
    expect(deriveProjectWorkingDir('/home/sam/.claude/skills/my-skill')).toBeNull();
  });

  it('project skill → project root (dirname 3 levels)', () => {
    const root = '/Users/sam/projects/foo';
    const p = `${root}/.claude/skills/my-skill`;
    expect(deriveProjectWorkingDir(p)).toBe(root);
  });

  it('deeper project path → correct root', () => {
    const root = '/home/sam/work/nested/project';
    const p = `${root}/.claude/skills/cool-skill`;
    expect(deriveProjectWorkingDir(p)).toBe(root);
  });
});

describe('deriveProjectWorkingDir (Windows)', () => {
  it('global skill Windows → null', () => {
    expect(deriveProjectWorkingDir('C:\\Users\\sam\\.claude\\skills\\my-skill')).toBeNull();
  });

  it('project skill Windows → project root', () => {
    expect(deriveProjectWorkingDir('C:\\work\\myrepo\\.claude\\skills\\awesome-skill')).toBe('C:\\work\\myrepo');
  });
});
