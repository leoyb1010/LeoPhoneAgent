import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

import { repairManagedDialogueWorkspaceSessions } from '../localDb/managedDialogueWorkspaceRepair';

let db: Database.Database | null = null;

function setupDb(): Database.Database {
  db = new Database(':memory:');
  db.exec(`
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      working_dir TEXT,
      workspace_kind TEXT NOT NULL DEFAULT 'project'
    );
  `);
  return db;
}

function rows(): Array<{ id: string; workspaceKind: string }> {
  return db!.prepare(`
    SELECT id, workspace_kind AS workspaceKind
    FROM sessions
    ORDER BY id
  `).all() as Array<{ id: string; workspaceKind: string }>;
}

afterEach(() => {
  db?.close();
  db = null;
});

describe('repairManagedDialogueWorkspaceSessions', () => {
  it('reclassifies app-managed dialogue cwd rows without touching real projects', () => {
    const localDb = setupDb();
    const root = path.join('/userData', 'dialogues');
    localDb.prepare('INSERT INTO sessions (id, working_dir, workspace_kind) VALUES (?, ?, ?)').run(
      'bad-dialogue',
      path.join(root, '2026-06-29', 'bad-dialogue'),
      'project',
    );
    localDb.prepare('INSERT INTO sessions (id, working_dir, workspace_kind) VALUES (?, ?, ?)').run(
      'already-dialogue',
      path.join(root, '2026-06-29', 'already-dialogue'),
      'dialogue',
    );
    localDb.prepare('INSERT INTO sessions (id, working_dir, workspace_kind) VALUES (?, ?, ?)').run(
      'real-project',
      '/Users/alice/Code/Tools/xdt-maker',
      'project',
    );
    localDb.prepare('INSERT INTO sessions (id, working_dir, workspace_kind) VALUES (?, ?, ?)').run(
      'dialogues-non-managed-project',
      path.join(root, 'scratch-project'),
      'project',
    );
    localDb.prepare('INSERT INTO sessions (id, working_dir, workspace_kind) VALUES (?, ?, ?)').run(
      'project-under-dialogues-day',
      path.join(root, '2026-06-29', 'not-this-session'),
      'project',
    );
    localDb.prepare('INSERT INTO sessions (id, working_dir, workspace_kind) VALUES (?, ?, ?)').run(
      'nested-dialogue-path',
      path.join(root, '2026-06-29', 'nested-dialogue-path', 'subdir'),
      'project',
    );

    expect(repairManagedDialogueWorkspaceSessions(localDb, root)).toBe(1);
    expect(rows()).toEqual([
      { id: 'already-dialogue', workspaceKind: 'dialogue' },
      { id: 'bad-dialogue', workspaceKind: 'dialogue' },
      { id: 'dialogues-non-managed-project', workspaceKind: 'project' },
      { id: 'nested-dialogue-path', workspaceKind: 'project' },
      { id: 'project-under-dialogues-day', workspaceKind: 'project' },
      { id: 'real-project', workspaceKind: 'project' },
    ]);
    expect(repairManagedDialogueWorkspaceSessions(localDb, root)).toBe(0);
  });

  it('no-ops when older schemas do not have workspace_kind yet', () => {
    db = new Database(':memory:');
    db.exec(`
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        working_dir TEXT
      );
    `);

    expect(repairManagedDialogueWorkspaceSessions(db, '/userData/dialogues')).toBe(0);
  });
});
