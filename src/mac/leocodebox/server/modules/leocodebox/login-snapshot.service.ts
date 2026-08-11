/**
 * Login-state snapshots (L5 / tracked #33). Some agent CLIs (Claude Code,
 * Codex) keep their official-account login in a credential file. This captures
 * that file as a NAMED snapshot so you can switch between accounts (e.g. work
 * vs personal Claude Max) without re-running each CLI's login flow. It is
 * complementary to Leoapi: Leoapi swaps API keys/endpoints, this swaps the
 * CLI's own OAuth login state.
 *
 * Applying a snapshot always backs up the current live credential first (先备份
 * 后覆盖), and every file is written 0600 under ~/.leocodebox/login-snapshots.
 */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

type StatusError = Error & { statusCode?: number };
function fail(message: string, statusCode = 400): StatusError {
  const error: StatusError = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function homeDir(): string {
  return process.env.LEOCODEBOX_TEST_HOME || os.homedir();
}

/** The credential file each target authenticates from, relative to home. */
const TARGET_CREDENTIAL_FILE: Record<string, string> = {
  claude: path.join('.claude', '.credentials.json'),
  codex: path.join('.codex', 'auth.json'),
};

export function isSnapshotTarget(target: string): boolean {
  return Object.prototype.hasOwnProperty.call(TARGET_CREDENTIAL_FILE, target);
}

function snapshotsRoot(): string {
  return path.join(homeDir(), '.leocodebox', 'login-snapshots');
}

/** Snapshot names are user-provided; keep them to a safe filename charset. */
export function sanitizeSnapshotName(value: unknown): string {
  return String(value ?? '').trim().replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '').slice(0, 60);
}

function credentialPath(target: string): string {
  return path.join(homeDir(), TARGET_CREDENTIAL_FILE[target]);
}
function snapshotPath(target: string, name: string): string {
  return path.join(snapshotsRoot(), target, `${name}.json`);
}

async function fileExists(p: string): Promise<boolean> {
  return fs.stat(p).then((s) => s.isFile()).catch(() => false);
}

/** Copy 0600 via temp + rename so a live credential is never left half-written. */
async function atomicCopy600(src: string, dest: string): Promise<void> {
  await fs.mkdir(path.dirname(dest), { recursive: true });
  const tmp = `${dest}.tmp-${Date.now().toString(36)}`;
  await fs.copyFile(src, tmp);
  await fs.chmod(tmp, 0o600).catch(() => { /* best effort on non-posix */ });
  await fs.rename(tmp, dest);
}

const AUTO_BACKUP_PREFIX = 'auto-backup-';
const MAX_AUTO_BACKUPS = 5;

/** Keep only the newest MAX_AUTO_BACKUPS auto-backups so they don't grow forever. */
async function pruneAutoBackups(target: string): Promise<void> {
  const dir = path.join(snapshotsRoot(), target);
  const entries = (await fs.readdir(dir).catch(() => [] as string[]))
    .filter((e) => e.startsWith(AUTO_BACKUP_PREFIX) && e.endsWith('.json'))
    .sort()
    .reverse();
  for (const stale of entries.slice(MAX_AUTO_BACKUPS)) {
    await fs.rm(path.join(dir, stale), { force: true }).catch(() => {});
  }
}

export type LoginSnapshot = { target: string; name: string; capturedAt: string; active: boolean };

export async function listSnapshots(target: string): Promise<LoginSnapshot[]> {
  if (!isSnapshotTarget(target)) throw fail('Unsupported target for login snapshots.');
  const dir = path.join(snapshotsRoot(), target);
  const entries = await fs.readdir(dir).catch(() => [] as string[]);
  const liveContent = await fs.readFile(credentialPath(target), 'utf8').catch(() => null);
  const snapshots: LoginSnapshot[] = [];
  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue;
    const name = entry.slice(0, -'.json'.length);
    const full = path.join(dir, entry);
    const stat = await fs.stat(full).catch(() => null);
    const content = await fs.readFile(full, 'utf8').catch(() => null);
    snapshots.push({
      target,
      name,
      capturedAt: stat ? stat.mtime.toISOString() : '',
      active: liveContent !== null && content === liveContent,
    });
  }
  return snapshots.sort((a, b) => b.capturedAt.localeCompare(a.capturedAt));
}

/** Copy the current live credential into a named snapshot. */
export async function captureSnapshot(target: string, rawName: string): Promise<LoginSnapshot> {
  if (!isSnapshotTarget(target)) throw fail('Unsupported target for login snapshots.');
  const name = sanitizeSnapshotName(rawName);
  if (!name) throw fail('A snapshot name is required.');
  const source = credentialPath(target);
  if (!(await fileExists(source))) throw fail(`${target} is not logged in (no credential file to snapshot).`, 409);
  const dest = snapshotPath(target, name);
  await atomicCopy600(source, dest);
  const stat = await fs.stat(dest);
  return { target, name, capturedAt: stat.mtime.toISOString(), active: true };
}

/** Restore a named snapshot to the live credential, backing up the current one first. */
export async function applySnapshot(target: string, rawName: string): Promise<{ applied: boolean; backup: string | null }> {
  if (!isSnapshotTarget(target)) throw fail('Unsupported target for login snapshots.');
  const name = sanitizeSnapshotName(rawName);
  const snap = snapshotPath(target, name);
  if (!(await fileExists(snap))) throw fail('Unknown snapshot.', 404);
  const live = credentialPath(target);

  let backup: string | null = null;
  if (await fileExists(live)) {
    const backupName = `${AUTO_BACKUP_PREFIX}${Date.now().toString(36)}`;
    await atomicCopy600(live, snapshotPath(target, backupName));
    backup = backupName;
    await pruneAutoBackups(target);
  }

  await atomicCopy600(snap, live);
  return { applied: true, backup };
}

export async function deleteSnapshot(target: string, rawName: string): Promise<boolean> {
  if (!isSnapshotTarget(target)) throw fail('Unsupported target for login snapshots.');
  const name = sanitizeSnapshotName(rawName);
  const snap = snapshotPath(target, name);
  if (!(await fileExists(snap))) return false;
  await fs.rm(snap, { force: true });
  return true;
}
