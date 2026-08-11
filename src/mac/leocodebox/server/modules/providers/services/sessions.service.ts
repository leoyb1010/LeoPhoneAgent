import { randomUUID } from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';

import { appConfigDb, projectsDb, sessionsDb, sessionRuntimeStateDb } from '@/modules/database/index.js';
import { chatRunRegistry } from '@/modules/websocket/index.js';
import { providerRegistry } from '@/modules/providers/provider.registry.js';
import type {
  FetchHistoryOptions,
  FetchHistoryResult,
  LLMProvider,
  NormalizedMessage,
} from '@/shared/types.js';
import { AppError, normalizeProjectPath } from '@/shared/utils.js';


const PINNED_SESSIONS_KEY = 'pinned_session_ids';

function readPinnedSessionIds(): Set<string> {
  try {
    const parsed = JSON.parse(appConfigDb.get(PINNED_SESSIONS_KEY) || '[]');
    return new Set(Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === 'string') : []);
  } catch {
    return new Set();
  }
}

function writePinnedSessionIds(ids: Set<string>): void {
  appConfigDb.set(PINNED_SESSIONS_KEY, JSON.stringify([...ids].slice(-500)));
}

function messageToMarkdown(message: NormalizedMessage): string {
  const timestamp = message.timestamp ? ` · ${message.timestamp}` : '';
  if (message.kind === 'tool_use') {
    return `### Tool: ${message.toolName || 'Tool'}${timestamp}\n\n\`\`\`json\n${JSON.stringify(message.toolInput ?? {}, null, 2)}\n\`\`\``;
  }
  const role = message.role === 'user' ? 'User' : message.kind === 'thinking' ? 'Thinking' : 'Assistant';
  const content = typeof message.content === 'string' ? message.content : '';
  return `## ${role}${timestamp}\n\n${content}`;
}

type CreateAppSessionResult = {
  sessionId: string;
  provider: LLMProvider;
  projectPath: string;
};

type ArchivedSessionListItem = {
  sessionId: string;
  provider: LLMProvider;
  projectId: string | null;
  projectPath: string | null;
  projectDisplayName: string;
  sessionTitle: string;
  createdAt: string | null;
  updatedAt: string | null;
  lastActivity: string | null;
  isProjectArchived: boolean;
};

/**
 * Removes one file if it exists.
 */
async function removeFileIfExists(filePath: string): Promise<boolean> {
  try {
    await fsp.unlink(filePath);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      return false;
    }
    throw error;
  }
}

/**
 * Archive rows need a stable project label even when the owning project is not
 * part of the active sidebar payload. This lightweight resolver keeps the
 * archive API self-contained while still matching the project's stored display
 * name when one exists.
 */
function resolveProjectDisplayName(
  projectPath: string | null,
  customProjectName: string | null | undefined,
): string {
  const trimmedCustomName = typeof customProjectName === 'string' ? customProjectName.trim() : '';
  if (trimmedCustomName.length > 0) {
    return trimmedCustomName;
  }

  if (!projectPath) {
    return 'Unknown Project';
  }

  return path.basename(projectPath) || projectPath;
}

/**
 * Application service for provider-backed session message operations.
 *
 * Callers pass a provider id and this service resolves the concrete provider
 * class, keeping normalization/history call sites decoupled from implementation
 * file layout.
 */
export const sessionsService = {
  /**
   * Lists provider ids that can load session history and normalize live messages.
   */
  listProviderIds(): LLMProvider[] {
    return providerRegistry.listProviders().map((provider) => provider.id);
  },

  /**
   * Returns app-facing ids for provider runs that are currently processing.
   *
   * This is intentionally status-only: callers that only need sidebar activity
   * indicators should not attach to chat streams or request replayed messages.
   */
  listRunningSessions(): Array<{
    sessionId: string;
    provider: LLMProvider;
    startedAt: number;
    lastSeq: number;
  }> {
    const active = chatRunRegistry.listRunningRuns();
    const activeIds = new Set(active.map((entry) => entry.sessionId));
    const recovered = sessionRuntimeStateDb.listRecoverable()
      .filter((entry) => !activeIds.has(entry.session_id))
      .map((entry) => ({ sessionId: entry.session_id, provider: entry.provider, startedAt: entry.started_at ?? Date.now(), lastSeq: 0 }));
    return [...active, ...recovered];
  },

  /**
   * Normalizes one provider-native event into frontend session message events.
   */
  normalizeMessage(
    providerName: string,
    raw: unknown,
    sessionId: string | null,
  ): NormalizedMessage[] {
    return providerRegistry.resolveProvider(providerName).sessions.normalizeMessage(raw, sessionId);
  },

  /**
   * Allocates a stable app-facing session id before any provider run happens.
   *
   * This is the entry point of the session gateway: the frontend calls this
   * (via `POST /api/providers/sessions`) when the user starts a brand-new
   * chat, navigates to the returned id immediately, and the id never changes
   * for the lifetime of the conversation. The provider-native id is mapped to
   * this row later, when the provider runtime announces it mid-run.
   */
  createAppSession(provider: LLMProvider, projectPath: string): CreateAppSessionResult {
    const normalizedProjectPath = normalizeProjectPath(projectPath);
    if (!normalizedProjectPath) {
      throw new AppError('projectPath is required.', {
        code: 'PROJECT_PATH_REQUIRED',
        statusCode: 400,
      });
    }

    const project = projectsDb.getProjectPath(normalizedProjectPath);
    if (!project || Boolean(project.isArchived)) {
      throw new AppError('请先在 leocodebox 中打开有效的本地项目，再创建会话。', {
        code: 'PROJECT_NOT_ACTIVE',
        statusCode: 404,
      });
    }

    const sessionId = randomUUID();
    sessionsDb.createAppSession(sessionId, provider, normalizedProjectPath);

    return {
      sessionId,
      provider,
      projectPath: normalizedProjectPath,
    };
  },

  /**
   * Fetches persisted history by app session id.
   *
   * Provider and provider-specific lookup hints are resolved from the indexed
   * session metadata in the database. The provider adapter receives the
   * provider-native session id (the one written into transcripts on disk),
   * and every returned message is remapped back to the app session id so
   * provider ids never reach the frontend.
   */
  async fetchHistory(
    sessionId: string,
    options: Pick<FetchHistoryOptions, 'limit' | 'offset'> = {},
  ): Promise<FetchHistoryResult> {
    const session = sessionsDb.getSessionById(sessionId);
    if (!session) {
      throw new AppError(`Session "${sessionId}" was not found.`, {
        code: 'SESSION_NOT_FOUND',
        statusCode: 404,
      });
    }

    // App-created sessions that never produced a provider transcript yet
    // (e.g. first message still streaming) simply have no history.
    if (!session.provider_session_id) {
      return {
        messages: [],
        total: 0,
        hasMore: false,
        offset: options.offset ?? 0,
        limit: options.limit ?? null,
      };
    }

    const provider = session.provider as LLMProvider;
    const result = await providerRegistry.resolveProvider(provider).sessions.fetchHistory(sessionId, {
      limit: options.limit ?? null,
      offset: options.offset ?? 0,
      projectPath: session.project_path ?? '',
      providerSessionId: session.provider_session_id,
    });

    return {
      ...result,
      messages: result.messages.map((message) => ({
        ...message,
        sessionId,
      })),
    };
  },

  /**
   * Returns archived sessions with enough project metadata for the sidebar to
   * group, filter, open, and restore them without a per-row follow-up query.
   */
  listArchivedSessions(): ArchivedSessionListItem[] {
    const archivedSessions = sessionsDb.getArchivedSessions();
    const projectCache = new Map<string, ReturnType<typeof projectsDb.getProjectPath>>();

    return archivedSessions.map((session) => {
      const projectPath = session.project_path?.trim() ? session.project_path : null;
      let project = null;

      if (projectPath) {
        if (!projectCache.has(projectPath)) {
          projectCache.set(projectPath, projectsDb.getProjectPath(projectPath));
        }
        project = projectCache.get(projectPath) ?? null;
      }

      return {
        sessionId: session.session_id,
        provider: session.provider as LLMProvider,
        projectId: project?.project_id ?? null,
        projectPath,
        projectDisplayName: resolveProjectDisplayName(projectPath, project?.custom_project_name),
        sessionTitle: session.custom_name?.trim() || session.session_id,
        createdAt: session.created_at ?? null,
        updatedAt: session.updated_at ?? null,
        lastActivity: session.updated_at ?? session.created_at ?? null,
        isProjectArchived: Boolean(project?.isArchived),
      };
    });
  },

  /**
   * Archives or permanently deletes one persisted session row by id.
   *
   * Soft-delete mirrors the project behavior by toggling `isArchived` so the
   * row disappears from active lists but remains restorable. Force-delete
   * optionally removes the transcript file before deleting the database row.
   */
  async deleteOrArchiveSessionById(
    sessionId: string,
    options: {
      force?: boolean;
      deletedFromDisk?: boolean;
    } = {},
  ): Promise<{ sessionId: string; action: 'archived' | 'deleted'; deletedFromDisk: boolean }> {
    const session = sessionsDb.getSessionById(sessionId);
    if (!session) {
      throw new AppError(`Session "${sessionId}" was not found.`, {
        code: 'SESSION_NOT_FOUND',
        statusCode: 404,
      });
    }

    if (!options.force) {
      sessionsDb.updateSessionIsArchived(sessionId, true);
      return {
        sessionId,
        action: 'archived',
        deletedFromDisk: false,
      };
    }

    let removedFromDisk = false;
    if (options.deletedFromDisk && session.jsonl_path) {
      removedFromDisk = await removeFileIfExists(session.jsonl_path);
    }

    const deleted = sessionsDb.deleteSessionById(sessionId);
    if (!deleted) {
      throw new AppError(`Session "${sessionId}" was not found.`, {
        code: 'SESSION_NOT_FOUND',
        statusCode: 404,
      });
    }

    return {
      sessionId,
      action: 'deleted',
      deletedFromDisk: removedFromDisk,
    };
  },

  /**
   * Restores one archived session back into the active sidebar lists.
   */
  restoreSessionById(sessionId: string): { sessionId: string; isArchived: false } {
    const session = sessionsDb.getSessionById(sessionId);
    if (!session) {
      throw new AppError(`Session "${sessionId}" was not found.`, {
        code: 'SESSION_NOT_FOUND',
        statusCode: 404,
      });
    }

    sessionsDb.updateSessionIsArchived(sessionId, false);
    return { sessionId, isArchived: false };
  },

  isSessionPinned(sessionId: string): boolean {
    return readPinnedSessionIds().has(sessionId);
  },

  setSessionPinned(sessionId: string, pinned: boolean): { sessionId: string; isPinned: boolean } {
    if (!sessionsDb.getSessionById(sessionId)) {
      throw new AppError(`Session "${sessionId}" was not found.`, { code: 'SESSION_NOT_FOUND', statusCode: 404 });
    }
    const ids = readPinnedSessionIds();
    if (pinned) ids.add(sessionId); else ids.delete(sessionId);
    writePinnedSessionIds(ids);
    return { sessionId, isPinned: pinned };
  },

  async exportSession(sessionId: string, format: 'markdown' | 'json'): Promise<{ fileName: string; mimeType: string; content: string }> {
    const session = sessionsDb.getSessionById(sessionId);
    if (!session) {
      throw new AppError(`Session "${sessionId}" was not found.`, { code: 'SESSION_NOT_FOUND', statusCode: 404 });
    }
    const history = await this.fetchHistory(sessionId, { limit: null, offset: 0 });
    const safeTitle = (session.custom_name || sessionId).replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || sessionId;
    if (format === 'json') {
      return {
        fileName: `${safeTitle}.json`,
        mimeType: 'application/json; charset=utf-8',
        content: JSON.stringify({ session, exportedAt: new Date().toISOString(), ...history }, null, 2),
      };
    }
    const title = session.custom_name || `Session ${sessionId}`;
    const header = `# ${title}\n\n- Provider: ${session.provider}\n- Session: ${sessionId}\n- Project: ${session.project_path || 'Unknown'}\n- Exported: ${new Date().toISOString()}\n`;
    return {
      fileName: `${safeTitle}.md`,
      mimeType: 'text/markdown; charset=utf-8',
      content: `${header}\n${history.messages.map(messageToMarkdown).join('\n\n---\n\n')}\n`,
    };

  },

  /**
   * Renames one session by id without requiring the caller to pass provider.
   */
  renameSessionById(sessionId: string, summary: string): { sessionId: string; summary: string } {
    const session = sessionsDb.getSessionById(sessionId);
    if (!session) {
      throw new AppError(`Session "${sessionId}" was not found.`, {
        code: 'SESSION_NOT_FOUND',
        statusCode: 404,
      });
    }

    sessionsDb.updateSessionCustomName(sessionId, summary);
    return { sessionId, summary };
  },
};
