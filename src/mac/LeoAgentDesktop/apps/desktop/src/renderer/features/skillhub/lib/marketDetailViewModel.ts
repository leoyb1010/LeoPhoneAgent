export type HubPreviewFileMeta = {
  path: string;
  size: number;
  language: string;
  truncated: boolean;
};

export type HubPreviewFile = HubPreviewFileMeta & {
  content: string;
};

export type PreviewTreeNode =
  | { type: 'file'; name: string; path: string }
  | { type: 'folder'; name: string; path: string; children: PreviewTreeNode[] };

export type MarketListVisibility = 'all' | 'mine' | 'available';
export type MarketCardPrimaryAction = 'manage' | 'clone' | 'none';
export type MarketCardState = 'not-installed' | 'installed-latest' | 'installed-outdated' | 'installing';

export type TeamOption = { slug: string; name: string; source?: string | null };
export type TeamScopeValue = {
  ownerTeamSlug: string;
  visibleDeptIds: string[];
  sharedTeamSlugs: string[];
};
export type MarketSelectionRow<TSkill> = {
  skill: TSkill;
  versionLabel: string;
  isOutdated: boolean;
};

function sortNodes(a: PreviewTreeNode, b: PreviewTreeNode): number {
  const priority = (node: PreviewTreeNode): number => {
    if (node.type === 'file' && node.name.toLowerCase() === 'skill.md') return 0;
    if (node.type === 'file' && node.name.toLowerCase() === 'readme.md') return 1;
    if (node.type === 'folder') return 2;
    return 3;
  };
  const byPriority = priority(a) - priority(b);
  if (byPriority !== 0) return byPriority;
  return a.name.localeCompare(b.name);
}

function insertPath(nodes: PreviewTreeNode[], parts: string[], fullPath: string): void {
  const [head, ...rest] = parts;
  if (!head) return;

  if (rest.length === 0) {
    nodes.push({ type: 'file', name: head, path: fullPath });
    return;
  }

  let folder = nodes.find(
    (node): node is Extract<PreviewTreeNode, { type: 'folder' }> =>
      node.type === 'folder' && node.name === head,
  );
  if (!folder) {
    const folderPath = fullPath.split('/').slice(0, parts.length - rest.length).join('/');
    folder = { type: 'folder', name: head, path: folderPath, children: [] };
    nodes.push(folder);
  }
  insertPath(folder.children, rest, fullPath);
}

function sortTree(nodes: PreviewTreeNode[]): PreviewTreeNode[] {
  return [...nodes]
    .map((node) => node.type === 'folder'
      ? { ...node, children: sortTree(node.children) }
      : node)
    .sort(sortNodes);
}

export function buildPreviewTree(files: HubPreviewFileMeta[]): PreviewTreeNode[] {
  const nodes: PreviewTreeNode[] = [];
  for (const file of files) {
    const parts = file.path.split('/').filter(Boolean);
    insertPath(nodes, parts, file.path);
  }
  return sortTree(nodes);
}

export function initialPreviewPath(files: HubPreviewFileMeta[]): string | null {
  for (const name of ['skill.md', 'readme.md']) {
    const match = files.find((file) => file.path.toLowerCase() === name);
    if (match) return match.path;
  }
  return files[0]?.path ?? null;
}

function isMarkdown(path: string, language: string): boolean {
  return language.toLowerCase() === 'markdown' || /\.mdx?$/i.test(path);
}

function stripYamlFrontmatter(content: string): string {
  const match = content.match(/^\uFEFF?---\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/);
  if (!match) return content;
  return content.slice(match[0].length);
}

export function previewBodyForFile(file: Pick<HubPreviewFile, 'path' | 'language' | 'content' | 'truncated'>): string {
  const suffix = file.truncated ? '\n\n<!-- 文件内容已截断 -->' : '';
  if (isMarkdown(file.path, file.language)) return `${stripYamlFrontmatter(file.content)}${suffix}`;
  const lang = file.language && file.language !== 'text' ? file.language : '';
  return `\`\`\`${lang}\n${file.content}\n\`\`\`${suffix}`;
}

export function marketCardPrimaryAction(input: {
  isMine: boolean;
  listVisibility: MarketListVisibility;
  cardState: MarketCardState;
}): MarketCardPrimaryAction {
  if (input.isMine && input.listVisibility === 'mine') return 'manage';
  if (input.listVisibility === 'all') return 'clone';
  if (input.cardState === 'not-installed') return 'clone';
  return 'none';
}

export function filterAvailableMarketItems<T extends {
  cardState: MarketCardState;
}>(items: T[]): T[] {
  // 「可获取」= 本地未装,不分作者。
  // 我发的但本地没有(换机器 / 卸载后)也应入选,能重新下载。
  return items.filter((item) => item.cardState === 'not-installed');
}

export function buildMarketSelectionRows<TSkill extends {
  kind: string;
  name: string;
  absolutePath: string;
}>(
  input: {
    selectedSkill: { name: string; isMine: boolean; latestVersion?: string | null } | null;
    installs: Array<{ skill: TSkill; entry: StoredInstall }>;
    skills: TSkill[];
    localCopyLabel: string;
  },
): MarketSelectionRow<TSkill>[] {
  const { selectedSkill, installs, skills, localCopyLabel } = input;
  if (!selectedSkill) return [];

  const registeredPaths = new Set(installs.map(({ skill }) => skill.absolutePath));
  const localCopies = selectedSkill.isMine
    ? skills.filter((skill) =>
      skill.kind === 'skill' &&
      skill.name === selectedSkill.name &&
      !registeredPaths.has(skill.absolutePath))
    : [];

  return [
    ...installs.map(({ skill, entry }) => ({
      skill,
      versionLabel: `v${entry.version}`,
      isOutdated: entry.version !== selectedSkill.latestVersion,
    })),
    ...localCopies.map((skill) => ({
      skill,
      versionLabel: localCopyLabel,
      isOutdated: false,
    })),
  ];
}
