import { describe, expect, it } from 'vitest';

import {
  buildMarketSelectionRows,
  buildPreviewTree,
  filterAvailableMarketItems,
  initialPreviewPath,
  marketCardPrimaryAction,
  previewBodyForFile,
} from '../marketDetailViewModel';

const files = [
  { path: 'workflow.md', size: 120, language: 'markdown', truncated: false },
  { path: 'examples/demo.md', size: 240, language: 'markdown', truncated: false },
  { path: 'SKILL.md', size: 360, language: 'markdown', truncated: false },
  { path: 'scripts/run.py', size: 480, language: 'python', truncated: false },
];

function makeSkill(overrides: Partial<SkillhubSkill> = {}): SkillhubSkill {
  return {
    id: 'skill:global:demo-skill',
    kind: 'skill',
    scope: 'global',
    name: 'demo-skill',
    absolutePath: '/home/sam/.agents/skills/demo-skill',
    mdPath: '/home/sam/.agents/skills/demo-skill/SKILL.md',
    files: [],
    registryEntry: null,
    ...overrides,
  } as SkillhubSkill;
}

function makeRegistryEntry(overrides: Partial<StoredInstall> = {}): StoredInstall {
  return {
    version: '1.0.0',
    authorId: 'owner',
    folderHash: 'hash',
    installedAt: 1,
    updatedAt: 1,
    origin: 'installed',
    ...overrides,
  } as StoredInstall;
}

describe('market cloud detail view model', () => {
  it('defaults the cloud detail preview to SKILL.md when Hub exposes it', () => {
    expect(initialPreviewPath(files)).toBe('SKILL.md');
  });

  it('builds a FILES tree from Hub preview paths without relying on local disk', () => {
    expect(buildPreviewTree(files)).toEqual([
      { type: 'file', name: 'SKILL.md', path: 'SKILL.md' },
      {
        type: 'folder',
        name: 'examples',
        path: 'examples',
        children: [{ type: 'file', name: 'demo.md', path: 'examples/demo.md' }],
      },
      {
        type: 'folder',
        name: 'scripts',
        path: 'scripts',
        children: [{ type: 'file', name: 'run.py', path: 'scripts/run.py' }],
      },
      { type: 'file', name: 'workflow.md', path: 'workflow.md' },
    ]);
  });

  it('strips markdown frontmatter and wraps non-markdown files for preview', () => {
    expect(previewBodyForFile({
      path: 'SKILL.md',
      language: 'markdown',
      content: '---\nname: helper\nversion: 1.0.0\n---\n# Helper\n\nBody',
      truncated: false,
    })).toBe('# Helper\n\nBody');

    expect(previewBodyForFile({
      path: 'scripts/run.py',
      language: 'python',
      content: 'print("hi")',
      truncated: false,
    })).toBe('```python\nprint("hi")\n```');
  });

  it('shows Manage only for owned cards inside My Published', () => {
    expect(marketCardPrimaryAction({
      isMine: true,
      listVisibility: 'mine',
      cardState: 'not-installed',
    })).toBe('manage');

    expect(marketCardPrimaryAction({
      isMine: true,
      listVisibility: 'all',
      cardState: 'not-installed',
    })).toBe('clone');

    expect(marketCardPrimaryAction({
      isMine: false,
      listVisibility: 'all',
      cardState: 'installed-latest',
    })).toBe('clone');

    expect(marketCardPrimaryAction({
      isMine: false,
      listVisibility: 'all',
      cardState: 'installing',
    })).toBe('clone');

    expect(marketCardPrimaryAction({
      isMine: false,
      listVisibility: 'available',
      cardState: 'not-installed',
    })).toBe('clone');

    expect(marketCardPrimaryAction({
      isMine: false,
      listVisibility: 'available',
      cardState: 'installed-outdated',
    })).toBe('none');
  });

  it('keeps Available on any not-installed skill regardless of author (mine included)', () => {
    const items = [
      { name: 'mine-not-installed', isMine: true, cardState: 'not-installed' as const },
      { name: 'other-latest', isMine: false, cardState: 'installed-latest' as const },
      { name: 'other-new', isMine: false, cardState: 'not-installed' as const },
      { name: 'other-update', isMine: false, cardState: 'installed-outdated' as const },
      { name: 'other-installing', isMine: false, cardState: 'installing' as const },
    ];

    // 我发的但本地未装(mine-not-installed)也应入选 —— 换机器后可重新下载。
    expect(filterAvailableMarketItems(items).map((item) => item.name)).toEqual([
      'mine-not-installed',
      'other-new',
    ]);
  });

  it('lists multiple registered installs and marks only outdated local versions', () => {
    const globalSkill = makeSkill({
      id: 'skill:global:demo-skill',
      absolutePath: '/home/sam/.agents/skills/demo-skill',
    });
    const projectSkill = makeSkill({
      id: 'skill:project:abc:demo-skill',
      scope: 'project',
      projectHash: 'abc',
      projectRoot: '/repo/app',
      absolutePath: '/repo/app/.claude/skills/demo-skill',
    });

    expect(buildMarketSelectionRows({
      selectedSkill: { name: 'demo-skill', isMine: false, latestVersion: '2.0.0' },
      installs: [
        { skill: globalSkill, entry: makeRegistryEntry({ version: '1.0.0' }) },
        { skill: projectSkill, entry: makeRegistryEntry({ version: '2.0.0' }) },
      ],
      skills: [globalSkill, projectSkill],
      localCopyLabel: 'Local copy',
    })).toEqual([
      { skill: globalSkill, versionLabel: 'v1.0.0', isOutdated: true },
      { skill: projectSkill, versionLabel: 'v2.0.0', isOutdated: false },
    ]);
  });

  it('does not treat unregistered same-name local folders as installed foreign market skills', () => {
    const localOnlySkill = makeSkill({
      absolutePath: '/home/sam/.codex/skills/demo-skill',
      registryEntry: null,
    });

    expect(buildMarketSelectionRows({
      selectedSkill: { name: 'demo-skill', isMine: false, latestVersion: '1.0.0' },
      installs: [],
      skills: [localOnlySkill],
      localCopyLabel: 'Local copy',
    })).toEqual([]);
  });

  it('shows unregistered local copies only for owned market skills and avoids duplicating registered paths', () => {
    const registeredSkill = makeSkill({
      absolutePath: '/home/sam/.agents/skills/demo-skill',
    });
    const localCopy = makeSkill({
      id: 'skill:project:abc:demo-skill',
      scope: 'project',
      projectHash: 'abc',
      projectRoot: '/repo/app',
      absolutePath: '/repo/app/.claude/skills/demo-skill',
      registryEntry: null,
    });

    expect(buildMarketSelectionRows({
      selectedSkill: { name: 'demo-skill', isMine: true, latestVersion: '1.0.0' },
      installs: [{ skill: registeredSkill, entry: makeRegistryEntry({ version: '1.0.0' }) }],
      skills: [registeredSkill, localCopy],
      localCopyLabel: 'Local copy',
    })).toEqual([
      { skill: registeredSkill, versionLabel: 'v1.0.0', isOutdated: false },
      { skill: localCopy, versionLabel: 'Local copy', isOutdated: false },
    ]);
  });

  it('ignores stale registry records once their folders disappear from the scan result', () => {
    expect(buildMarketSelectionRows({
      selectedSkill: { name: 'demo-skill', isMine: false, latestVersion: '1.0.0' },
      installs: [],
      skills: [],
      localCopyLabel: 'Local copy',
    })).toEqual([]);
  });
});
