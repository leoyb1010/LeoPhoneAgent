import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { projectsDb } from '@/modules/database/index.js';
import { normalizeProjectPath } from '@/shared/utils.js';

export type SessionWorkspace = {
  projectId: string;
  path: string;
  fullPath: string;
  displayName: string;
};

const BLOCKED_EXACT = new Set(['/', '/etc', '/bin', '/sbin', '/usr', '/dev', '/proc', '/sys', '/var', '/boot', '/root', '/lib', '/lib64', '/opt', '/run']);
const BLOCKED_PREFIX = ['/etc/', '/dev/', '/proc/', '/sys/', '/boot/', '/root/'];

/** 会话 cwd 常写成 ~ 或 ~/…,项目表要绝对路径。 */
export function expandSessionCwd(cwd: string, home = os.homedir()): string {
  const raw = cwd.trim();
  if (!raw || raw === '~') return home;
  if (raw.startsWith('~/') || raw.startsWith('~\\')) return path.join(home, raw.slice(2));
  return raw;
}

export function sessionCwdAllowed(cwd: string): boolean {
  const normalized = normalizeProjectPath(path.resolve(expandSessionCwd(cwd)));
  if (!normalized) return false;
  if (BLOCKED_EXACT.has(normalized)) return false;
  return !BLOCKED_PREFIX.some((prefix) => normalized.startsWith(prefix));
}

export function workspaceFromRow(row: { project_id: string; project_path: string; custom_project_name?: string | null }): SessionWorkspace {
  const fullPath = row.project_path;
  return {
    projectId: row.project_id,
    path: fullPath,
    fullPath,
    displayName: (row.custom_project_name || '').trim() || path.basename(fullPath) || fullPath,
  };
}

/**
 * 本机文件树走 /api/projects/:id/files,必须有项目表里的真 id。
 * 2.0 会话只有 cwd:按路径复用或登记,不编 harness- 假 id,也不套 WORKSPACES_ROOT
 * (会话目录经常在 /tmp 或任意工作副本里)。
 */
export async function ensureSessionWorkspace(cwd: string): Promise<SessionWorkspace> {
  const expanded = expandSessionCwd(cwd);
  const normalized = normalizeProjectPath(path.resolve(expanded));
  if (!normalized || !sessionCwdAllowed(normalized)) {
    throw new Error('这个目录不能当会话工作区');
  }
  const stats = await fs.stat(normalized).catch(() => null);
  if (stats && !stats.isDirectory()) throw new Error('路径存在,但不是目录');
  if (!stats) await fs.mkdir(normalized, { recursive: true });

  const existing = projectsDb.getProjectPath(normalized);
  if (existing) return workspaceFromRow(existing);

  const persisted = projectsDb.createProjectPath(normalized, path.basename(normalized));
  if (persisted.outcome === 'active_conflict') {
    const again = projectsDb.getProjectPath(normalized);
    if (again) return workspaceFromRow(again);
  }
  const row = persisted.project ?? projectsDb.getProjectPath(normalized);
  if (!row) throw new Error('无法登记这个目录');
  return workspaceFromRow(row);
}
