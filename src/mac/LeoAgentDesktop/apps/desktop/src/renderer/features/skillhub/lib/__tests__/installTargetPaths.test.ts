import { describe, expect, it } from 'vitest';

import {
  isInstallPathForSkill,
  isInstallPathUnderProject,
  joinSkillInstallPath,
  normalizeInstallPathKey,
} from '../installTargetPaths';

describe('install target path helpers', () => {
  it('normalizes POSIX install paths without changing case', () => {
    expect(normalizeInstallPathKey('/Users/Sam/Repo/.agents/skills/Demo/')).toBe(
      '/Users/Sam/Repo/.agents/skills/Demo',
    );
  });

  it('normalizes Windows install paths for registry comparison', () => {
    expect(normalizeInstallPathKey('C:\\Users\\Sam\\Repo\\.agents\\skills\\Demo\\')).toBe(
      'c:/users/sam/repo/.agents/skills/demo',
    );
    expect(normalizeInstallPathKey('C:/Users/Sam/Repo/.agents/skills/Demo')).toBe(
      'c:/users/sam/repo/.agents/skills/demo',
    );
  });

  it('joins install paths using the separator style of the chosen base dir', () => {
    expect(joinSkillInstallPath('/Users/sam/repo', 'demo')).toBe('/Users/sam/repo/.agents/skills/demo');
    expect(joinSkillInstallPath('C:\\Users\\Sam\\Repo', 'demo')).toBe(
      'C:\\Users\\Sam\\Repo\\.agents\\skills\\demo',
    );
  });

  it('matches installed skill paths across Windows separator and case differences', () => {
    expect(isInstallPathForSkill('C:\\Users\\Sam\\.agents\\skills\\Demo', 'demo')).toBe(true);
    expect(isInstallPathForSkill('/Users/Sam/.agents/skills/Demo', 'demo')).toBe(false);
  });

  it('detects project installs across Windows separator and case differences', () => {
    expect(isInstallPathUnderProject(
      'C:\\Work\\Repo\\.agents\\skills\\Demo',
      'C:/work/repo',
    )).toBe(true);
    expect(isInstallPathUnderProject(
      'C:\\Work\\Repo2\\.agents\\skills\\Demo',
      'C:/work/repo',
    )).toBe(false);
  });
});
