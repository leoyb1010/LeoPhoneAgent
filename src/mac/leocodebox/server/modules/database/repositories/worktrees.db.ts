import { getConnection } from '@/modules/database/connection.js';

export type StoredWorktree = {
  id: string;
  projectPath: string;
  slug: string;
  branch: string;
  path: string;
  createdAt: string;
};

type Row = { worktree_id: string; project_path: string; slug: string; branch: string; path: string; created_at: string };

const rowToWorktree = (row: Row): StoredWorktree => ({
  id: row.worktree_id,
  projectPath: row.project_path,
  slug: row.slug,
  branch: row.branch,
  path: row.path,
  createdAt: row.created_at,
});

export const worktreesDb = {
  create(worktree: Omit<StoredWorktree, 'createdAt'>): StoredWorktree {
    const db = getConnection();
    db.prepare(
      `INSERT INTO worktrees (worktree_id, project_path, slug, branch, path, created_at)
       VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
    ).run(worktree.id, worktree.projectPath, worktree.slug, worktree.branch, worktree.path);
    return worktreesDb.get(worktree.id)!;
  },
  get(id: string): StoredWorktree | null {
    const row = getConnection().prepare(
      'SELECT worktree_id, project_path, slug, branch, path, created_at FROM worktrees WHERE worktree_id = ?',
    ).get(id) as Row | undefined;
    return row ? rowToWorktree(row) : null;
  },
  listByProject(projectPath: string): StoredWorktree[] {
    const rows = getConnection().prepare(
      'SELECT worktree_id, project_path, slug, branch, path, created_at FROM worktrees WHERE project_path = ? ORDER BY created_at DESC',
    ).all(projectPath) as Row[];
    return rows.map(rowToWorktree);
  },
  listAll(): StoredWorktree[] {
    const rows = getConnection().prepare(
      'SELECT worktree_id, project_path, slug, branch, path, created_at FROM worktrees ORDER BY created_at DESC',
    ).all() as Row[];
    return rows.map(rowToWorktree);
  },
  hasSlug(projectPath: string, slug: string): boolean {
    const row = getConnection().prepare(
      'SELECT 1 FROM worktrees WHERE project_path = ? AND slug = ?',
    ).get(projectPath, slug);
    return Boolean(row);
  },
  delete(id: string): boolean {
    return getConnection().prepare('DELETE FROM worktrees WHERE worktree_id = ?').run(id).changes > 0;
  },
};
