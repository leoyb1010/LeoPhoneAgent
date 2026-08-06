import type Database from 'better-sqlite3';

// Migration scripts are loaded by the desktop migration runner through
// CommonJS require. Keep runtime imports in CJS form so Node's type stripping
// does not evaluate this file as ESM and remove `module`.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const fs = require('node:fs') as typeof import('node:fs');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const os = require('node:os') as typeof import('node:os');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const path = require('node:path') as typeof import('node:path');

interface RunOptions {
  codexHomes?: string[];
}

function tableColumnNames(db: Database.Database, tableName: string): string[] {
  return db
    .prepare(`PRAGMA table_info('${tableName}')`)
    .all()
    .map((row) => String((row as { name: unknown }).name));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function defaultCodexHomes(): string[] {
  const candidates = new Set<string>();
  const add = (candidate: string | undefined) => {
    if (candidate) candidates.add(path.resolve(candidate));
  };

  add(process.env.CODEX_HOME);
  add(path.join(os.homedir(), '.codex'));
  if (process.platform === 'darwin') {
    const appSupport = path.join(os.homedir(), 'Library', 'Application Support');
    add(path.join(appSupport, 'Codex', 'codex-home'));
    add(path.join(appSupport, 'Codex'));
  } else if (process.platform === 'win32') {
    const appData = process.env.APPDATA;
    add(appData ? path.join(appData, 'Codex', 'codex-home') : undefined);
    add(appData ? path.join(appData, 'Codex') : undefined);
  } else {
    add(path.join(os.homedir(), '.config', 'codex'));
  }

  return [...candidates];
}

function readProjectlessThreadIds(codexHome: string): string[] {
  const statePath = path.join(codexHome, '.codex-global-state.json');
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  } catch {
    return [];
  }
  if (!isRecord(parsed)) return [];
  const raw = parsed['projectless-thread-ids'];
  if (!Array.isArray(raw)) return [];
  return raw.filter((id): id is string => typeof id === 'string' && id.length > 0);
}

function run(db: Database.Database, options: RunOptions = {}): void {
  const sessionColumns = new Set(tableColumnNames(db, 'sessions'));
  if (
    !sessionColumns.has('workspace_kind') ||
    !sessionColumns.has('agent_kind') ||
    !sessionColumns.has('sdk_session_id')
  ) {
    return;
  }

  const projectlessThreadIds = new Set<string>();
  for (const codexHome of options.codexHomes ?? defaultCodexHomes()) {
    for (const id of readProjectlessThreadIds(codexHome)) {
      projectlessThreadIds.add(id);
    }
  }
  if (projectlessThreadIds.size === 0) return;

  const markDialogue = db.prepare(`
    UPDATE sessions
    SET workspace_kind = 'dialogue'
    WHERE agent_kind = 'codex'
      AND sdk_session_id = ?
      AND workspace_kind != 'dialogue'
  `);
  for (const threadId of projectlessThreadIds) {
    markDialogue.run(threadId);
  }
}

module.exports = { run, readProjectlessThreadIds };
