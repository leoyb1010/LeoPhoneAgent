import type { SpawnOptions } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';

import spawn from 'cross-spawn';

import { projectsDb } from '../database/index.js';

type GitCommandResult = { stdout: string; stderr: string };
type GitCommandError = Error & { code?: number | null; stdout?: string; stderr?: string };
export type GitStatusResult = { modified: string[]; added: string[]; deleted: string[]; untracked: string[]; staged: string[] };


function spawnAsync(command: string, args: string[], options: SpawnOptions = {}): Promise<GitCommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      ...options,
      shell: false,
    });

    let stdout = '';
    let stderr = '';

    child.stdout?.on('data', (data: Buffer) => {
      stdout += data.toString();
    });

    child.stderr?.on('data', (data: Buffer) => {
      stderr += data.toString();
    });

    child.on('error', (error) => {
      reject(error);
    });

    child.on('close', (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }

      const error = new Error(`Command failed: ${command} ${args.join(' ')}`) as GitCommandError;
      error.code = code;
      error.stdout = stdout;
      error.stderr = stderr;
      reject(error);
    });
  });
}

// Input validation helpers (defense-in-depth)
function validateCommitRef(commit: string): string {
  // Allow hex hashes, HEAD, HEAD~N, HEAD^N, tag names, branch names.
  // The leading `(?!-)` rejects refs that begin with a dash so they can never be
  // smuggled into git as command-line options (e.g. `--upload-pack=...`).
  if (!/^(?!-)[a-zA-Z0-9._~^{}@\/-]+$/.test(commit)) {
    throw new Error('Invalid commit reference');
  }
  return commit;
}

function validateBranchName(branch: string): string {
  // Leading `(?!-)` rejects dash-prefixed names so they cannot be interpreted as
  // git options when passed positionally.
  if (!/^(?!-)[a-zA-Z0-9._\/-]+$/.test(branch)) {
    throw new Error('Invalid branch name');
  }
  return branch;
}

function validateFilePath(file: string, projectPath?: string): string {
  if (!file || file.includes('\0')) {
    throw new Error('Invalid file path');
  }
  // Prevent path traversal: resolve the file relative to the project root
  // and ensure the result stays within the project directory
  if (projectPath) {
    const resolved = path.resolve(projectPath, file);
    const normalizedRoot = path.resolve(projectPath) + path.sep;
    if (!resolved.startsWith(normalizedRoot) && resolved !== path.resolve(projectPath)) {
      throw new Error('Invalid file path: path traversal detected');
    }
  }
  return file;
}

function validateRemoteName(remote: string): string {
  if (!/^[a-zA-Z0-9._-]+$/.test(remote)) {
    throw new Error('Invalid remote name');
  }
  return remote;
}

function validateProjectPath(projectPath: string): string {
  if (!projectPath || projectPath.includes('\0')) {
    throw new Error('Invalid project path');
  }
  const resolved = path.resolve(projectPath);
  // Must be an absolute path after resolution
  if (!path.isAbsolute(resolved)) {
    throw new Error('Invalid project path: must be absolute');
  }
  // Block obviously dangerous paths
  if (resolved === '/' || resolved === path.sep) {
    throw new Error('Invalid project path: root directory not allowed');
  }
  return resolved;
}

/**
 * Resolve the absolute project directory for a given DB `projectId`.
 *
 * After the projectName → projectId migration, every git endpoint receives
 * the DB primary key (`project` query/body param). The legacy filesystem
 * resolver that walked Claude's JSONL history is no longer used here; the
 * path comes straight from the `projects` table and is then sanity-checked
 * by `validateProjectPath` before any `git` command runs against it.
 */
async function getActualProjectPath(projectId: string): Promise<string> {
  const projectPath = await projectsDb.getProjectPathById(projectId);
  if (!projectPath) {
    throw new Error(`Unable to resolve project path for "${projectId}"`);
  }
  return validateProjectPath(projectPath);
}

// Helper function to strip git diff headers
function stripDiffHeaders(diff: string): string {
  if (!diff) return '';

  const lines = diff.split('\n');
  const filteredLines = [];
  let startIncluding = false;

  for (const line of lines) {
    // Skip all header lines including diff --git, index, file mode, and --- / +++ file paths
    if (line.startsWith('diff --git') ||
        line.startsWith('index ') ||
        line.startsWith('new file mode') ||
        line.startsWith('deleted file mode') ||
        line.startsWith('---') ||
        line.startsWith('+++')) {
      continue;
    }

    // Start including lines from @@ hunk headers onwards
    if (line.startsWith('@@') || startIncluding) {
      startIncluding = true;
      filteredLines.push(line);
    }
  }

  return filteredLines.join('\n');
}

// Helper function to validate git repository
async function validateGitRepository(projectPath: string): Promise<void> {
  try {
    // Check if directory exists
    await fs.access(projectPath);
  } catch {
    throw new Error(`Project path not found: ${projectPath}`);
  }

  try {
    // Allow any directory that is inside a work tree (repo root or nested folder).
    const { stdout: insideWorkTreeOutput } = await spawnAsync('git', ['rev-parse', '--is-inside-work-tree'], { cwd: projectPath });
    const isInsideWorkTree = insideWorkTreeOutput.trim() === 'true';
    if (!isInsideWorkTree) {
      throw new Error('Not inside a git work tree');
    }

    // Ensure git can resolve the repository root for this directory.
    await spawnAsync('git', ['rev-parse', '--show-toplevel'], { cwd: projectPath });
  } catch {
    throw new Error('Not a git repository. This directory does not contain a .git folder. Initialize a git repository with "git init" to use source control features.');
  }
}

function getGitErrorDetails(error: unknown): string {
  const commandError = error as Partial<GitCommandError> | null | undefined;
  return `${commandError?.message || ''} ${commandError?.stderr || ''} ${commandError?.stdout || ''}`;
}

function isMissingHeadRevisionError(error: unknown): boolean {
  const errorDetails = getGitErrorDetails(error).toLowerCase();
  return errorDetails.includes('unknown revision')
    || errorDetails.includes('ambiguous argument')
    || errorDetails.includes('needed a single revision')
    || errorDetails.includes('bad revision');
}

async function getCurrentBranchName(projectPath: string): Promise<string> {
  try {
    // symbolic-ref works even when the repository has no commits.
    const { stdout } = await spawnAsync('git', ['symbolic-ref', '--short', 'HEAD'], { cwd: projectPath });
    const branchName = stdout.trim();
    if (branchName) {
      return branchName;
    }
  } catch (error) {
    // Fall back to rev-parse for detached HEAD and older git edge cases.
  }

  const { stdout } = await spawnAsync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: projectPath });
  return stdout.trim();
}

async function repositoryHasCommits(projectPath: string): Promise<boolean> {
  try {
    await spawnAsync('git', ['rev-parse', '--verify', 'HEAD'], { cwd: projectPath });
    return true;
  } catch (error) {
    if (isMissingHeadRevisionError(error)) {
      return false;
    }
    throw error;
  }
}

async function getRepositoryRootPath(projectPath: string): Promise<string> {
  const { stdout } = await spawnAsync('git', ['rev-parse', '--show-toplevel'], { cwd: projectPath });
  return stdout.trim();
}

function normalizeRepositoryRelativeFilePath(filePath: string): string {
  return String(filePath)
    .replace(/\\/g, '/')
    .replace(/^\.\/+/, '')
    .replace(/^\/+/, '')
    .trim();
}

function parseStatusFilePaths(statusOutput: string): string[] {
  return statusOutput
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line.trim())
    .map((line) => {
      const statusPath = line.substring(3);
      const renamedFilePath = statusPath.split(' -> ')[1];
      return normalizeRepositoryRelativeFilePath(renamedFilePath || statusPath);
    })
    .filter(Boolean);
}

function buildFilePathCandidates(projectPath: string, repositoryRootPath: string, filePath: string): string[] {
  const normalizedFilePath = normalizeRepositoryRelativeFilePath(filePath);
  const projectRelativePath = normalizeRepositoryRelativeFilePath(path.relative(repositoryRootPath, projectPath));
  const candidates = [normalizedFilePath];

  if (
    projectRelativePath
    && projectRelativePath !== '.'
    && !normalizedFilePath.startsWith(`${projectRelativePath}/`)
  ) {
    candidates.push(`${projectRelativePath}/${normalizedFilePath}`);
  }

  return Array.from(new Set(candidates.filter(Boolean)));
}

async function resolveRepositoryFilePath(projectPath: string, filePath: string): Promise<{ repositoryRootPath: string; repositoryRelativeFilePath: string }> {
  validateFilePath(filePath);

  const repositoryRootPath = await getRepositoryRootPath(projectPath);
  const candidateFilePaths = buildFilePathCandidates(projectPath, repositoryRootPath, filePath);

  for (const candidateFilePath of candidateFilePaths) {
    const { stdout } = await spawnAsync('git', ['status', '--porcelain', '--', candidateFilePath], { cwd: repositoryRootPath });
    if (stdout.trim()) {
      return {
        repositoryRootPath,
        repositoryRelativeFilePath: candidateFilePath,
      };
    }
  }

  // If the caller sent a bare filename (e.g. "hello.ts"), recover it from changed files.
  const normalizedFilePath = normalizeRepositoryRelativeFilePath(filePath);
  if (!normalizedFilePath.includes('/')) {
    const { stdout: repositoryStatusOutput } = await spawnAsync('git', ['status', '--porcelain'], { cwd: repositoryRootPath });
    const changedFilePaths = parseStatusFilePaths(repositoryStatusOutput);
    const suffixMatches = changedFilePaths.filter(
      (changedFilePath) => changedFilePath === normalizedFilePath || changedFilePath.endsWith(`/${normalizedFilePath}`),
    );

    if (suffixMatches.length === 1) {
      return {
        repositoryRootPath,
        repositoryRelativeFilePath: suffixMatches[0],
      };
    }
  }

  return {
    repositoryRootPath,
    repositoryRelativeFilePath: candidateFilePaths[0],
  };
}

// Get git status for a project
/**
 * Parses `git status --porcelain=v1 -z` output into the response shape the
 * git panel consumes. NUL-separated entries carry no path quoting, so names
 * with spaces/unicode survive intact (the plain porcelain output quotes and
 * escapes them, which broke the old line-based parser).
 *
 * `staged` lists paths with index-side changes. The UI renders its "Staged"
 * section from this list so it always mirrors the real git index (including
 * files staged outside the app, e.g. via VSCode or the terminal).
 *
 * Exported for tests.
 */
export function parseGitStatusOutput(statusOutput: string): GitStatusResult {
  const modified: string[] = [];
  const added: string[] = [];
  const deleted: string[] = [];
  const untracked: string[] = [];
  const staged: string[] = [];

  const statusEntries = statusOutput.split('\0');
  for (let entryIndex = 0; entryIndex < statusEntries.length; entryIndex++) {
    const entry = statusEntries[entryIndex];
    if (!entry || entry.length < 4) continue;

    // Porcelain v1: X = index (staged) status, Y = worktree (unstaged) status.
    const indexStatus = entry[0];
    const worktreeStatus = entry[1];
    const file = entry.slice(3);

    // Renames/copies carry the original path as the following NUL entry;
    // the UI tracks the post-rename path only.
    if (indexStatus === 'R' || indexStatus === 'C') {
      entryIndex += 1;
    }

    if (indexStatus === '?') {
      untracked.push(file);
      continue;
    }
    if (indexStatus === '!') {
      continue; // ignored files are never reported
    }

    const isConflict =
      indexStatus === 'U' || worktreeStatus === 'U' ||
      (indexStatus === 'A' && worktreeStatus === 'A') ||
      (indexStatus === 'D' && worktreeStatus === 'D');
    if (isConflict) {
      // Merge conflicts must be resolved in the worktree first; surface them
      // as modified and never as staged.
      modified.push(file);
      continue;
    }

    if (indexStatus !== ' ') {
      staged.push(file);
    }

    if (indexStatus === 'D' || worktreeStatus === 'D') {
      deleted.push(file);
    } else if (indexStatus === 'A' || worktreeStatus === 'A') {
      added.push(file);
    } else {
      modified.push(file);
    }
  }

  return { modified, added, deleted, untracked, staged };
}


export {
  buildFilePathCandidates,
  getActualProjectPath,
  getCurrentBranchName,
  getGitErrorDetails,
  getRepositoryRootPath,
  isMissingHeadRevisionError,
  normalizeRepositoryRelativeFilePath,
  parseStatusFilePaths,
  repositoryHasCommits,
  resolveRepositoryFilePath,
  spawnAsync,
  stripDiffHeaders,
  validateBranchName,
  validateCommitRef,
  validateFilePath,
  validateGitRepository,
  validateProjectPath,
  validateRemoteName,
};
