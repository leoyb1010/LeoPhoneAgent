/**
 * derivations.test.ts — deriveScope / deriveProjectWorkingDir / sanitizeSkillName 单测
 */
import { describe, it, expect } from 'vitest';
import os from 'node:os';
import path from 'node:path';

// 直接 import（无副作用，不需要 mock）
import { deriveScope, deriveProjectWorkingDir, sanitizeSkillName } from '../derivations.js';

const home = os.homedir();
const globalBase = path.join(home, '.claude', 'skills');

describe('deriveScope', () => {
  it('global skill path → global', () => {
    const p = path.join(globalBase, 'my-skill');
    expect(deriveScope(p)).toBe('global');
  });

  it('global skill path with nested dir → global', () => {
    const p = path.join(globalBase, 'my-skill', 'subdir');
    expect(deriveScope(p)).toBe('global');
  });

  it('project skill path → project', () => {
    const p = path.join('/Users/sam/projects/foo', '.claude', 'skills', 'my-skill');
    expect(deriveScope(p)).toBe('project');
  });

  it('unrelated path → project', () => {
    expect(deriveScope('/some/random/path')).toBe('project');
  });

  it('Windows-style path normalized → global', () => {
    // path.normalize 会处理 \\ 分隔符（Windows）
    const winPath = path.join(globalBase, 'my-skill');
    expect(deriveScope(winPath)).toBe('global');
  });

  it('path that looks like global but is not under .claude → project', () => {
    const p = path.join(home, 'skills', 'my-skill'); // 没有 .claude
    expect(deriveScope(p)).toBe('project');
  });
});

describe('deriveProjectWorkingDir', () => {
  it('global skill → null', () => {
    const p = path.join(globalBase, 'my-skill');
    expect(deriveProjectWorkingDir(p)).toBeNull();
  });

  it('project skill → project root (dirname 3 levels)', () => {
    const root = path.join('/Users/sam/projects/foo');
    const p = path.join(root, '.claude', 'skills', 'my-skill');
    expect(deriveProjectWorkingDir(p)).toBe(path.normalize(root));
  });

  it('another project path → correct root', () => {
    const root = path.join('C:', 'work', 'myrepo');
    const p = path.join(root, '.claude', 'skills', 'awesome-skill');
    expect(deriveProjectWorkingDir(p)).toBe(path.normalize(root));
  });
});

describe('sanitizeSkillName', () => {
  it('valid names pass through', () => {
    expect(sanitizeSkillName('my-skill')).toBe('my-skill');
    expect(sanitizeSkillName('abc123')).toBe('abc123');
    expect(sanitizeSkillName('a')).toBe('a');
    expect(sanitizeSkillName('a'.repeat(200))).toBe('a'.repeat(200));
  });

  it('empty string throws REGISTRY_INVALID_NAME', () => {
    expect(() => sanitizeSkillName('')).toThrowError(expect.objectContaining({ code: 'REGISTRY_INVALID_NAME' }));
  });

  it('name with uppercase throws', () => {
    expect(() => sanitizeSkillName('MySkill')).toThrowError(expect.objectContaining({ code: 'REGISTRY_INVALID_NAME' }));
  });

  it('name with underscore throws', () => {
    expect(() => sanitizeSkillName('my_skill')).toThrowError(expect.objectContaining({ code: 'REGISTRY_INVALID_NAME' }));
  });

  it('name with space throws', () => {
    expect(() => sanitizeSkillName('my skill')).toThrowError(expect.objectContaining({ code: 'REGISTRY_INVALID_NAME' }));
  });

  it('name longer than 200 chars throws', () => {
    expect(() => sanitizeSkillName('a'.repeat(201))).toThrowError(expect.objectContaining({ code: 'REGISTRY_INVALID_NAME' }));
  });

  it('name with special chars throws', () => {
    expect(() => sanitizeSkillName('my/skill')).toThrowError(expect.objectContaining({ code: 'REGISTRY_INVALID_NAME' }));
    expect(() => sanitizeSkillName('my.skill')).toThrowError(expect.objectContaining({ code: 'REGISTRY_INVALID_NAME' }));
  });
});
