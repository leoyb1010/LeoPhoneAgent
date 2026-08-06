export interface HubSkillInfoForDesktop {
  slug: string;
  displayName?: string;
  summary?: string | null;
  description?: string;
  version: string;
  marketVersion?: string;
  pendingVersion?: {
    version: string;
    status?: string;
  };
  folderHash?: string;
  fileHash?: string;
  owner: { type?: string; slug: string; name: string };
  visibility: string;
  moderationStatus?: string;
  updatedAt: string;
  isMine?: boolean;
  categories?: Array<{ slug: string; name: string }>;
  stats?: {
    downloads?: number;
  };
}

interface MapOptions {
  forceMine?: boolean;
}

export function mapHubSkillInfoToDesktopInfo(hub: HubSkillInfoForDesktop, opts?: MapOptions) {
  return {
    name: hub.slug,
    displayName: hub.displayName ?? hub.slug,
    description: hub.summary ?? hub.description ?? '',
    authorId: hub.owner.slug,
    authorName: hub.owner.name,
    authorAvatarUrl: null as string | null,
    isMine: opts?.forceMine === true || hub.isMine === true,
    latestVersion: hub.version,
    folderHash: hub.folderHash ?? hub.fileHash,
    visibility: (hub.visibility === 'public' ? 'PUBLIC' : 'DEPARTMENT_SCOPED') as 'PUBLIC' | 'DEPARTMENT_SCOPED',
    publishedVisibility: (hub.visibility === 'private' || hub.visibility === 'shared' || hub.visibility === 'public'
      ? hub.visibility
      : undefined) as 'private' | 'shared' | 'public' | undefined,
    ownerType: hub.owner.type as string | undefined,
    moderationStatus: hub.moderationStatus,
    marketVersion: hub.marketVersion,
    pendingVersion: hub.pendingVersion,
    visibleDeptIds: [] as string[],
    categories: (hub.categories ?? []).map((category) => category.slug),
    publishedAt: hub.updatedAt,
    downloads: Number.isFinite(hub.stats?.downloads) ? hub.stats?.downloads ?? 0 : 0,
    latestPublishedFromDeviceId: null as string | null,
  };
}
