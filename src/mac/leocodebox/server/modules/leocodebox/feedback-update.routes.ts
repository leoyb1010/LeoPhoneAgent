import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import express from 'express';

import { findAppRoot, getModuleDir } from '../../utils/runtime-paths.js';

import { compareSemver, fetchJson } from './version-network.utils.js';

const router = express.Router();
const APP_ROOT = findAppRoot(getModuleDir(import.meta.url));
const MAX_TEXT_FIELD = 20_000;

type PackageMetadata = {
  name?: string;
  version?: string;
  repository?: string | { url?: string };
};
type ReleaseMetadata = { tag_name?: string; name?: string; html_url?: string };
type StatusError = Error & { statusCode?: number };
type UpdateCheckResult = {
  checkedAt: string;
  current: { name: string; version: string | null };
  own: { repository: string; latest: string | null; updateAvailable: boolean; url: string; error: string | null };
};

function toNodeError(error: unknown): NodeJS.ErrnoException {
  return error instanceof Error ? error as NodeJS.ErrnoException : new Error(String(error));
}


function homeDir(): string {
  return process.env.LEOCODEBOX_TEST_HOME || os.homedir();
}

function feedbackDir(): string {
  return path.join(homeDir(), '.leocodebox', 'feedback');
}

function nowIso(): string {
  return new Date().toISOString();
}

function safeText(value: unknown, max = MAX_TEXT_FIELD): string {
  return String(value == null ? '' : value).slice(0, max).trim();
}

async function ensureDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  try {
    await fs.chmod(dir, 0o700);
  } catch {
    // chmod is best-effort on filesystems that support POSIX modes.
  }
}

async function writeJsonFile(filePath: string, value: unknown): Promise<void> {
  await ensureDir(path.dirname(filePath));
  const tempPath = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await fs.writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await fs.rename(tempPath, filePath);
  try {
    await fs.chmod(filePath, 0o600);
  } catch {
    // chmod is best-effort on filesystems that support POSIX modes.
  }
}

async function readJsonFile<T>(filePath: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf8'));
  } catch (error) {
    if (toNodeError(error).code === 'ENOENT') return fallback;
    throw error;
  }
}

function parseRepositoryUrl(repository: PackageMetadata['repository']): string | null {
  const value = typeof repository === 'string' ? repository : repository?.url;
  if (!value) return null;
  const match = value.match(/github\.com[:/](.+?)(?:\.git)?$/);
  return match ? match[1] : null;
}

async function readPackageJson(): Promise<PackageMetadata> {
  try {
    return JSON.parse(await fs.readFile(path.join(APP_ROOT, 'package.json'), 'utf8')) as PackageMetadata;
  } catch {
    return {};
  }
}

async function checkUpdates(): Promise<UpdateCheckResult> {
  const pkg = await readPackageJson();
  const currentVersion = pkg.version || null;
  const repoPath = parseRepositoryUrl(pkg.repository) || 'leoyb1010/leocodebox';
  const result: UpdateCheckResult = {
    checkedAt: nowIso(),
    current: { name: pkg.name || 'leocodebox', version: currentVersion },
    own: {
      repository: repoPath,
      latest: null,
      updateAvailable: false,
      url: `https://github.com/${repoPath}/releases`,
      error: null,
    },
  };

  try {
    const release = await fetchJson(`https://api.github.com/repos/${repoPath}/releases/latest`) as ReleaseMetadata;
    result.own.latest = release.tag_name || release.name || null;
    result.own.url = release.html_url || result.own.url;
    result.own.updateAvailable = Boolean(
      currentVersion && result.own.latest && compareSemver(result.own.latest, currentVersion) > 0,
    );
  } catch (error) {
    const statusError = toNodeError(error) as StatusError;
    result.own.error = statusError.statusCode === 404
      ? 'Private release metadata is unavailable here. Check updates in Settings > About.'
      : statusError.message;
  }
  return result;
}

router.post('/feedback', async (req, res, next) => {
  try {
    const payload = {
      id: crypto.randomUUID(),
      createdAt: nowIso(),
      role: safeText(req.body?.role, 80),
      severity: safeText(req.body?.severity, 40),
      area: safeText(req.body?.area, 120),
      title: safeText(req.body?.title, 200),
      description: safeText(req.body?.description),
      steps: safeText(req.body?.steps),
      expected: safeText(req.body?.expected),
      actual: safeText(req.body?.actual),
      pageUrl: safeText(req.body?.pageUrl, 1000),
      userAgent: safeText(req.body?.userAgent, 1000),
      appVersion: safeText(req.body?.appVersion, 80),
      language: safeText(req.body?.language, 40),
    };
    if (!payload.title || !payload.description) {
      res.status(400).json({ success: false, error: 'Title and description are required.' });
      return;
    }

    await ensureDir(feedbackDir());
    const fileName = `${payload.createdAt.replace(/[:.]/g, '-')}-${payload.id}.json`;
    const filePath = path.join(feedbackDir(), fileName);
    await writeJsonFile(filePath, payload);
    res.json({ success: true, id: payload.id, filePath });
  } catch (error) {
    next(error);
  }
});

router.get('/feedback', async (_req, res, next) => {
  try {
    let files: string[] = [];
    try {
      files = await fs.readdir(feedbackDir());
    } catch (error) {
      if (toNodeError(error).code !== 'ENOENT') throw error;
    }
    const reports: Array<Record<string, unknown> & { fileName: string }> = [];
    for (const fileName of files.filter((file) => file.endsWith('.json')).sort().reverse().slice(0, 100)) {
      try {
        const report = await readJsonFile<Record<string, unknown> | null>(path.join(feedbackDir(), fileName), null);
        if (report) reports.push({ ...report, fileName });
      } catch {
        // Skip malformed local report files.
      }
    }
    res.json({ success: true, reports, directory: feedbackDir() });
  } catch (error) {
    next(error);
  }
});

router.get('/updates/check', async (_req, res, next) => {
  try {
    res.json({ success: true, updates: await checkUpdates() });
  } catch (error) {
    next(error);
  }
});

export default router;
export { checkUpdates };
