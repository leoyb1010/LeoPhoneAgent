import { simpleGit, type SimpleGit } from 'simple-git';

export interface FileDiffStat {
  file: string;
  insertions: number;
  deletions: number;
}

export interface DiffResult {
  files: string[];
  fileStats: FileDiffStat[];
  insertions: number;
  deletions: number;
}

/**
 * Find the git repository root for the given working directory.
 * Throws if not inside a git repository (D5: project-context strictly requires git).
 */
export async function findRepoRoot(cwd: string): Promise<string> {
  const git: SimpleGit = simpleGit(cwd);
  try {
    const root = await git.revparse(['--show-toplevel']);
    return root.trim();
  } catch {
    throw new Error(
      `Not inside a git repository (cwd=${cwd}). project-context requires git; ` +
        `initialize one with \`git init\` or run from inside a git repo.`,
    );
  }
}

export async function getCurrentHead(repoRoot: string): Promise<string> {
  const git = simpleGit(repoRoot);
  const sha = await git.revparse(['HEAD']);
  return sha.trim();
}

/**
 * Compute file-level diff stats between two commits (or commit..HEAD).
 * Returns the list of changed files (relative to repo root) and aggregate line counts.
 */
export async function getDiff(repoRoot: string, fromRef: string, toRef = 'HEAD'): Promise<DiffResult> {
  const git = simpleGit(repoRoot);
  // simple-git diffSummary parses `git diff --shortstat --numstat`.
  const summary = await git.diffSummary([`${fromRef}..${toRef}`]);
  return {
    files: summary.files.map((f) => f.file),
    fileStats: summary.files.flatMap((f) => {
      if (f.binary) return [];
      const t = f as { file: string; insertions: number; deletions: number };
      return [{ file: t.file, insertions: t.insertions, deletions: t.deletions }];
    }),
    insertions: summary.insertions,
    deletions: summary.deletions,
  };
}

/**
 * Get the raw unified-diff text for a specific set of files. Used to feed agent adapter.
 */
export async function getDiffText(
  repoRoot: string,
  fromRef: string,
  toRef: string,
  files: string[],
): Promise<string> {
  const git = simpleGit(repoRoot);
  const args = [`${fromRef}..${toRef}`, '--', ...files];
  return git.diff(args);
}
