import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { projectsDb, sessionsDb } from '@/modules/database/index.js';
import { sessionSynchronizerService, sessionsService } from '@/modules/providers/index.js';
import { WS_OPEN_STATE, connectedClients } from '@/modules/websocket/index.js';
import type { RealtimeClientConnection } from '@/shared/types.js';
import { AppError } from '@/shared/utils.js';

type SessionSummary = {
  id: string;
  provider: string;
  summary: string;
  messageCount: number;
  lastActivity: string;
  isPinned: boolean;
};

type SessionRepositoryRow = {
  provider: string;
  session_id: string;
  custom_name?: string | null;
  updated_at?: string | null;
  created_at?: string | null;
};

export type ProjectListItem = {
  projectId: string;
  path: string;
  displayName: string;
  fullPath: string;
  isStarred: boolean;
  /** Non-archived session counts per provider (claude/codex/cursor/opencode). */
  providerCounts: Record<string, number>;
  sessions: SessionSummary[];
  sessionMeta: {
    hasMore: boolean;
    total: number;
  };
};

export type ArchivedProjectListItem = ProjectListItem & {
  isArchived: true;
};

type ProgressUpdate = {
  phase: 'loading' | 'complete';
  current: number;
  total: number;
  currentProject?: string;
};

type GetProjectsWithSessionsOptions = {
  skipSynchronization?: boolean;
  sessionsLimit?: number;
  sessionsOffset?: number;
};

type SessionPaginationOptions = {
  limit?: number;
  offset?: number;
};

type ProjectSessionsPageResult = {
  sessions: SessionSummary[];
  total: number;
  hasMore: boolean;
};

export type ProjectSessionsPageApiView = {
  projectId: string;
  sessions: SessionSummary[];
  sessionMeta: {
    hasMore: boolean;
    total: number;
  };
};

const DEFAULT_PROJECT_SESSIONS_PAGE_SIZE = 20;
const MAX_PROJECT_SESSIONS_PAGE_SIZE = 200;
const PROVIDER_DISPLAY_NAMES: Record<string, string> = {
  claude: 'Claude Code',
  codex: 'Codex',
  cursor: 'Cursor',
  opencode: 'OpenCode',
};
const GENERIC_PATH_SEGMENTS = new Set([
  'data',
  'projects',
  'project',
  'namespaces',
  'release-stable',
  'sessions',
  'session',
  'workspaces',
  'workspace',
  'documents',
  'library',
  'application support',
]);
const URL_NOISE_TOKENS = new Set(['http', 'https', 'www', 'com', 'net', 'org', 'cn', 'top', 'url']);
const LOCAL_PATH_NOISE_TOKENS = new Set([
  'users',
  'desktop',
  'documents',
  'workspace',
  'workspaces',
  'codex',
  'library',
  'application',
  'support',
  'github',
]);

function providerDisplayName(provider: string | null | undefined): string {
  const normalized = String(provider || '').toLowerCase();
  return PROVIDER_DISPLAY_NAMES[normalized] || (provider ? provider : 'Agent');
}

/**
 * Identifies ephemeral, one-off working directories that pollute the project
 * list — git worktrees, temp dirs, scratchpads, and per-run agent/session
 * folders (bare UUIDs, `agent-<hex>`, date-stamped one-off containers).
 * Starred projects are never treated as junk (caller enforces this).
 */
export function isJunkProjectPath(
  projectPath: string,
  homeDir = os.homedir(),
  existsSyncImpl: typeof existsSync = existsSync,
): boolean {
  const normalized = String(projectPath || '').replace(/\\/g, '/');
  const normalizedHome = String(homeDir || '').replace(/\\/g, '/').replace(/\/$/, '');
  const segments = normalized.split('/').filter(Boolean);
  const leaf = segments[segments.length - 1] || '';

  if (normalizedHome && normalized.replace(/\/$/, '') === normalizedHome) return true;
  if (/\/worktrees\//.test(normalized)) return true;
  if (/(^|\/)(private\/tmp|tmp|var\/folders)\//.test(normalized)) return true;
  if (/\/scratchpad(\/|$)/.test(normalized)) return true;
  if (/\/\.claude-mem\/observer-sessions(\/|$)/i.test(normalized)) return true;
  if (/\.app\/Contents\/Resources(\/|$)/i.test(normalized)) return true;
  if (/\/Library\/Application Support\/(?!Mobile Documents(?:\/|$))/i.test(normalized)) return true;
  if (/^files-mentioned-by-the-user-/i.test(leaf)) return true;
  if (/^agent-[0-9a-f]{12,}$/i.test(leaf)) return true;
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(leaf)) return true;
  // One-off workspace sitting DIRECTLY inside a date-stamped container
  // (e.g. .../Codex/2026-07-06/<one-off>). Scoped to the immediate parent only,
  // so a real project deeper under a dated tree (…/2026-07-09/work/my-app) is
  // NOT hidden.
  const parent = segments[segments.length - 2];
  if (
    parent
    && /^\d{4}[-_]\d{2}[-_]\d{2}$/.test(parent)
    && !existsSyncImpl(path.join(projectPath, '.git'))
  ) return true;

  return false;
}

/**
 * Returns false only when the directory is provably gone (ENOENT). Other errors
 * (EACCES, an unmounted network drive, etc.) fail OPEN — we keep the project
 * listed rather than hide a real workspace that is merely temporarily
 * unreachable.
 */
async function directoryExists(dirPath: string): Promise<boolean> {
  try {
    const stats = await fs.stat(dirPath);
    return stats.isDirectory();
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code !== 'ENOENT';
  }
}

function isIdentifierLike(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) return true;
  if (/^untitled\b/i.test(trimmed)) return true;
  if (/^new\s+(session|conversation)$/i.test(trimmed)) return true;
  if (/^\d{10,}$/.test(trimmed)) return true;
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(trimmed)) return true;
  if (/^[0-9a-f]{24,}$/i.test(trimmed)) return true;
  if (/^session[-_][a-z0-9_-]{12,}$/i.test(trimmed)) return true;
  if (/^\/[^ ]+/.test(trimmed) || /^[A-Za-z]:[\\/]/.test(trimmed)) return true;
  return false;
}

function shortSessionId(sessionId: string): string {
  const cleaned = String(sessionId || '').replace(/[^a-zA-Z0-9]/g, '');
  return cleaned ? cleaned.slice(-6).toUpperCase() : 'LOCAL';
}

function humanizePathSegment(segment: string): string {
  const cleaned = segment
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned || segment;
}

function cleanSlugTokens(tokens: string[], noiseTokens: Set<string> = new Set()): string[] {
  const seen = new Set<string>();
  const cleaned: string[] = [];
  for (const token of tokens) {
    const normalized = token.toLowerCase().trim();
    if (!normalized || noiseTokens.has(normalized)) continue;
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    cleaned.push(token);
  }
  return cleaned;
}

function nameFromTokens(tokens: string[]): string | null {
  if (tokens.length === 0) return null;
  const name = humanizePathSegment(tokens.join('-'));
  return name && !isIdentifierLike(name) ? name : null;
}

function stripDatePrefix(segment: string): string {
  return segment.replace(/^\d{4}-\d{2}-\d{2}-/, '');
}

function githubRepoNameFromReverseSlug(slug: string): string | null {
  const tokens = slug.split(/[-_]+/).filter(Boolean);
  if (tokens.length < 2) return null;

  const ownerTokenCount = /\d/.test(tokens[0]) || tokens[1] !== 'ai' ? 1 : 2;
  return nameFromTokens(tokens.slice(ownerTokenCount));
}

export function friendlyProjectLeafName(segment: string): string | null {
  const normalizedSegment = stripDatePrefix(segment);

  const agentWorkspace = normalizedSegment.match(/^agent-([a-z0-9]{12,})$/i);
  if (agentWorkspace?.[1]) return `Agent: ${shortSessionId(agentWorkspace[1])}`;

  const filesMentioned = normalizedSegment.match(/^files-mentioned-by-the-user-(.+)$/i);
  if (filesMentioned?.[1]) {
    const name = humanizePathSegment(filesMentioned[1]);
    return /^\d+$/.test(name) || isIdentifierLike(name) ? `用户文件: ${shortSessionId(name)}` : name;
  }

  const githubUrl = normalizedSegment.match(/^(?:github-)?https-github-com-(.+)$/i);
  if (githubUrl?.[1]) return githubRepoNameFromReverseSlug(githubUrl[1]);

  const reverseGithubUrl = normalizedSegment.match(/^(.+)-https-github-com$/i);
  if (reverseGithubUrl?.[1]) return githubRepoNameFromReverseSlug(reverseGithubUrl[1]);

  const genericUrl = normalizedSegment.match(/^(?:url-)?https-(.+)$/i);
  if (genericUrl?.[1]) {
    const tokens = cleanSlugTokens(genericUrl[1].split(/[-_]+/).filter(Boolean), URL_NOISE_TOKENS);
    const name = nameFromTokens(tokens);
    if (name) return name;
  }

  const pluginWorkspace = normalizedSegment.match(/^(?:github|chrome|browser)-plugin-(.+)$/i);
  if (pluginWorkspace?.[1]) {
    const tokens = cleanSlugTokens(pluginWorkspace[1].split(/[-_]+/).filter(Boolean), URL_NOISE_TOKENS);
    return nameFromTokens(tokens);
  }

  const localPathTokens = normalizedSegment.split(/[-_]+/).filter(Boolean);
  const usersIndex = localPathTokens.findIndex((token) => token.toLowerCase() === 'users');
  if (usersIndex >= 0 && localPathTokens[usersIndex + 1]) {
    localPathTokens.splice(usersIndex + 1, 1);
    const tokens = cleanSlugTokens(localPathTokens, LOCAL_PATH_NOISE_TOKENS);
    const name = nameFromTokens(tokens);
    if (name) return name;
  }

  return null;
}

function meaningfulProjectDisplayName(projectPath: string): string {
  const parts = projectPath.split(path.sep).filter(Boolean);
  const leaf = parts[parts.length - 1] || projectPath;
  const friendlyLeaf = friendlyProjectLeafName(leaf);
  if (friendlyLeaf) return friendlyLeaf;
  if (!isIdentifierLike(leaf)) return humanizePathSegment(leaf);

  const parent = [...parts]
    .reverse()
    .find((segment) => {
      const normalized = segment.toLowerCase();
      return segment !== leaf
        && !GENERIC_PATH_SEGMENTS.has(normalized)
        && !isIdentifierLike(segment);
    });

  const prefix = parent ? humanizePathSegment(parent) : '本地工作区';
  return `${prefix}: ${shortSessionId(leaf)}`;
}

function sessionDisplaySummary(row: SessionRepositoryRow): string {
  const providerName = providerDisplayName(row.provider);
  const customName = (row.custom_name || '').trim();
  if (customName && !isIdentifierLike(customName)) {
    return customName.startsWith(`${providerName}:`) ? customName : `${providerName}: ${customName}`;
  }

  return `${providerName}: 本地对话 ${shortSessionId(row.session_id)}`;
}

/**
 * Generate better display name from path.
 */
export async function generateDisplayName(projectName: string, actualProjectDir: string | null = null): Promise<string> {
  // Use actual project directory if provided, otherwise decode from project name.
  const projectPath = actualProjectDir || projectName.replace(/-/g, '/');

  // Try to read package.json from the project path.
  try {
    const packageJsonPath = path.join(projectPath, 'package.json');
    const packageData = await fs.readFile(packageJsonPath, 'utf8');
    const packageJson = JSON.parse(packageData) as { name?: string };

    // Return the name from package.json if it exists.
    if (packageJson.name) {
      return isIdentifierLike(packageJson.name)
        ? meaningfulProjectDisplayName(projectPath)
        : packageJson.name;
    }
  } catch {
    // Fall back to path-based naming if package.json doesn't exist or can't be read.
  }

  // If it starts with /, it's an absolute path.
  if (projectPath.startsWith('/')) {
    return meaningfulProjectDisplayName(projectPath);
  }

  return isIdentifierLike(projectPath) ? meaningfulProjectDisplayName(projectPath) : projectPath;
}

function normalizeSessionPagination(options: SessionPaginationOptions = {}): { limit: number; offset: number } {
  const rawLimit = Number.isFinite(options.limit) ? Math.floor(Number(options.limit)) : DEFAULT_PROJECT_SESSIONS_PAGE_SIZE;
  const rawOffset = Number.isFinite(options.offset) ? Math.floor(Number(options.offset)) : 0;

  return {
    limit: Math.min(Math.max(1, rawLimit), MAX_PROJECT_SESSIONS_PAGE_SIZE),
    offset: Math.max(0, rawOffset),
  };
}

function mapSessionRowToSummary(row: SessionRepositoryRow): SessionSummary {
  return {
    id: row.session_id,
    provider: row.provider,
    summary: sessionDisplaySummary(row),
    messageCount: 0,
    lastActivity: row.updated_at ?? row.created_at ?? new Date().toISOString(),
    isPinned: sessionsService.isSessionPinned(row.session_id),
  };
}

function readProjectSessionsIncludingArchived(projectPath: string): ProjectSessionsPageResult {
  const rows = sessionsDb.getSessionsByProjectPathIncludingArchived(projectPath) as SessionRepositoryRow[];

  return {
    sessions: rows.map(mapSessionRowToSummary),
    total: rows.length,
    hasMore: false,
  };
}

/**
 * Reads one paginated project session slice from the DB and groups rows by provider.
 */
function readProjectSessionsPageByPath(
  projectPath: string,
  options: SessionPaginationOptions = {},
): ProjectSessionsPageResult {
  const pagination = normalizeSessionPagination(options);
  const rows = sessionsDb.getSessionsByProjectPathPage(
    projectPath,
    pagination.limit,
    pagination.offset,
  ) as SessionRepositoryRow[];
  const total = sessionsDb.countSessionsByProjectPath(projectPath);

  return {
    sessions: rows.map(mapSessionRowToSummary),
    total,
    hasMore: pagination.offset + rows.length < total,
  };
}

// Broadcast progress to all connected WebSocket clients.
// Uses the unified `kind` envelope like every other websocket frame.
function broadcastProgress(progress: ProgressUpdate) {
  const message = JSON.stringify({
    kind: 'loading_progress',
    ...progress,
  });

  connectedClients.forEach((client: RealtimeClientConnection) => {
    if (client.readyState === WS_OPEN_STATE) {
      client.send(message);
    }
  });
}

/**
 * Reads all projects from DB and returns normalized session summaries.
 */
export async function getProjectsWithSessions(
  options: GetProjectsWithSessionsOptions = {}
): Promise<ProjectListItem[]> {
  if (!options.skipSynchronization) {
    await sessionSynchronizerService.synchronizeSessions();
  }

  const projectRows = projectsDb.getProjectPaths() as Array<{
    project_id: string;
    project_path: string;
    custom_project_name?: string | null;
    isStarred?: number;
  }>;
  const totalProjects = projectRows.length;
  const projects: ProjectListItem[] = [];
  let processedProjects = 0;

  for (const row of projectRows) {
    processedProjects += 1;

    const projectId = row.project_id;
    const projectPath = row.project_path;

    broadcastProgress({
      phase: 'loading',
      current: processedProjects,
      total: totalProjects,
      currentProject: projectPath,
    });

    const customProjectName = row.custom_project_name?.trim();
    const friendlyCustomProjectName = customProjectName ? friendlyProjectLeafName(customProjectName) : null;
    const displayName =
      friendlyCustomProjectName
        ? friendlyCustomProjectName
        : customProjectName && !isIdentifierLike(customProjectName)
        ? humanizePathSegment(customProjectName)
        : await generateDisplayName(path.basename(projectPath) || projectPath, projectPath);

    const sessionsPage = readProjectSessionsPageByPath(projectPath, {
      limit: options.sessionsLimit,
      offset: options.sessionsOffset,
    });

    // Filter noise from the active list, but never hide a starred project.
    const isStarred = Boolean(row.isStarred);
    if (!isStarred) {
      if (isJunkProjectPath(projectPath)) continue;
      if (!(await directoryExists(projectPath))) continue;
      // Keep the default sidebar focused on actual conversation history. Empty
      // repositories remain reachable by creating a project again, while a
      // starred empty project is intentionally preserved above.
      if (sessionsPage.total === 0) continue;
    }

    projects.push({
      projectId,
      path: projectPath,
      displayName,
      fullPath: projectPath,
      isStarred,
      providerCounts: sessionsDb.getSessionProviderCountsByProjectPath(projectPath),
      sessions: sessionsPage.sessions,
      sessionMeta: {
        hasMore: sessionsPage.hasMore,
        total: sessionsPage.total,
      },
    });
  }

  broadcastProgress({
    phase: 'complete',
    current: totalProjects,
    total: totalProjects,
  });

  return projects;
}

/**
 * Reads archived projects from DB and includes every session row for each
 * project path, because an archived workspace should surface all preserved
 * conversation history in the archive view regardless of each session's flag.
 */
export async function getArchivedProjectsWithSessions(
  options: Pick<GetProjectsWithSessionsOptions, 'skipSynchronization'> = {},
): Promise<ArchivedProjectListItem[]> {
  if (!options.skipSynchronization) {
    await sessionSynchronizerService.synchronizeSessions();
  }

  const projectRows = projectsDb.getArchivedProjectPaths() as Array<{
    project_id: string;
    project_path: string;
    custom_project_name?: string | null;
    isStarred?: number;
  }>;

  const archivedProjects: ArchivedProjectListItem[] = [];

  for (const row of projectRows) {
    const customProjectName = row.custom_project_name?.trim();
    const friendlyCustomProjectName = customProjectName ? friendlyProjectLeafName(customProjectName) : null;
    const displayName =
      friendlyCustomProjectName
        ? friendlyCustomProjectName
        : customProjectName && !isIdentifierLike(customProjectName)
        ? humanizePathSegment(customProjectName)
        : await generateDisplayName(path.basename(row.project_path) || row.project_path, row.project_path);

    const sessionsPage = readProjectSessionsIncludingArchived(row.project_path);

    archivedProjects.push({
      projectId: row.project_id,
      path: row.project_path,
      displayName,
      fullPath: row.project_path,
      isStarred: Boolean(row.isStarred),
      providerCounts: sessionsDb.getSessionProviderCountsByProjectPath(row.project_path),
      isArchived: true,
      sessions: sessionsPage.sessions,
      sessionMeta: {
        hasMore: sessionsPage.hasMore,
        total: sessionsPage.total,
      },
    });
  }

  return archivedProjects;
}

/**
 * Loads one paginated session slice for a specific project id.
 */
export async function getProjectSessionsPage(
  projectId: string,
  options: SessionPaginationOptions = {},
): Promise<ProjectSessionsPageApiView> {
  const projectRow = projectsDb.getProjectById(projectId);
  if (!projectRow) {
    throw new AppError(`Project "${projectId}" was not found.`, {
      code: 'PROJECT_NOT_FOUND',
      statusCode: 404,
    });
  }

  const sessionsPage = readProjectSessionsPageByPath(projectRow.project_path, options);
  return {
    projectId: projectRow.project_id,
    sessions: sessionsPage.sessions,
    sessionMeta: {
      hasMore: sessionsPage.hasMore,
      total: sessionsPage.total,
    },
  };
}
