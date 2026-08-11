import path from 'path';
import { promises as fs } from 'fs';

import express from 'express';


import { generateCommitMessageWithAI } from './git-commit-message.service.js';
import remoteRoutes from './git-remote.routes.js';
import workingTreeRoutes from './git-working-tree.routes.js';
import {
  getActualProjectPath,
  parseGitStatusOutput,
  getCurrentBranchName,
  getRepositoryRootPath,
  repositoryHasCommits,
  resolveRepositoryFilePath,
  spawnAsync,
  stripDiffHeaders,
  validateBranchName,
  validateCommitRef,
  validateGitRepository,
} from './git.service.js';

const router = express.Router();
const COMMIT_DIFF_CHARACTER_LIMIT = 500_000;

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function getErrorStderr(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'stderr' in error) {
    return String(error.stderr ?? '');
  }
  return '';
}


router.get('/status', async (req, res) => {
  const project = typeof req.query.project === 'string' ? req.query.project : '';

  if (!project) {
    return res.status(400).json({ error: 'Project id is required' });
  }

  try {
    const projectPath = await getActualProjectPath(project);

    // Validate git repository
    await validateGitRepository(projectPath);

    const branch = await getCurrentBranchName(projectPath);
    const hasCommits = await repositoryHasCommits(projectPath);

    const { stdout: statusOutput } = await spawnAsync('git', ['status', '--porcelain=v1', '-z'], { cwd: projectPath });
    const { modified, added, deleted, untracked, staged } = parseGitStatusOutput(statusOutput);

    res.json({
      branch,
      hasCommits,
      modified,
      added,
      deleted,
      untracked,
      staged
    });
  } catch (error) {
    console.error('Git status error:', error);
    res.json({
      error: getErrorMessage(error).includes('not a git repository') || getErrorMessage(error).includes('Project directory is not a git repository')
        ? getErrorMessage(error)
        : 'Git operation failed',
      details: getErrorMessage(error).includes('not a git repository') || getErrorMessage(error).includes('Project directory is not a git repository')
        ? getErrorMessage(error)
        : `Failed to get git status: ${getErrorMessage(error)}`
    });
  }
});

// Get diff for a specific file
router.get('/diff', async (req, res) => {
  const project = typeof req.query.project === 'string' ? req.query.project : '';
  const file = typeof req.query.file === 'string' ? req.query.file : '';

  if (!project || !file) {
    return res.status(400).json({ error: 'Project id and file path are required' });
  }

  try {
    const projectPath = await getActualProjectPath(project);

    // Validate git repository
    await validateGitRepository(projectPath);

    const {
      repositoryRootPath,
      repositoryRelativeFilePath,
    } = await resolveRepositoryFilePath(projectPath, file);

    // Check if file is untracked or deleted
    const { stdout: statusOutput } = await spawnAsync(
      'git',
      ['status', '--porcelain', '--', repositoryRelativeFilePath],
      { cwd: repositoryRootPath },
    );
    const isUntracked = statusOutput.startsWith('??');
    const isDeleted = statusOutput.trim().startsWith('D ') || statusOutput.trim().startsWith(' D');

    let diff;
    if (isUntracked) {
      // For untracked files, show the entire file content as additions
      const filePath = path.join(repositoryRootPath, repositoryRelativeFilePath);
      const stats = await fs.stat(filePath);

      if (stats.isDirectory()) {
        // For directories, show a simple message
        diff = `Directory: ${repositoryRelativeFilePath}\n(Cannot show diff for directories)`;
      } else {
        const fileContent = await fs.readFile(filePath, 'utf-8');
        const lines = fileContent.split('\n');
        diff = `--- /dev/null\n+++ b/${repositoryRelativeFilePath}\n@@ -0,0 +1,${lines.length} @@\n` +
               lines.map(line => `+${line}`).join('\n');
      }
    } else if (isDeleted) {
      // For deleted files, show the entire file content from HEAD as deletions
      const { stdout: fileContent } = await spawnAsync(
        'git',
        ['show', `HEAD:${repositoryRelativeFilePath}`],
        { cwd: repositoryRootPath },
      );
      const lines = fileContent.split('\n');
      diff = `--- a/${repositoryRelativeFilePath}\n+++ /dev/null\n@@ -1,${lines.length} +0,0 @@\n` +
             lines.map(line => `-${line}`).join('\n');
    } else {
      // Get diff for tracked files
      // First check for unstaged changes (working tree vs index)
      const { stdout: unstagedDiff } = await spawnAsync(
        'git',
        ['diff', '--', repositoryRelativeFilePath],
        { cwd: repositoryRootPath },
      );

      if (unstagedDiff) {
        // Show unstaged changes if they exist
        diff = stripDiffHeaders(unstagedDiff);
      } else {
        // If no unstaged changes, check for staged changes (index vs HEAD)
        const { stdout: stagedDiff } = await spawnAsync(
          'git',
          ['diff', '--cached', '--', repositoryRelativeFilePath],
          { cwd: repositoryRootPath },
        );
        diff = stripDiffHeaders(stagedDiff) || '';
      }
    }

    res.json({ diff });
  } catch (error) {
    console.error('Git diff error:', error);
    res.json({ error: getErrorMessage(error) });
  }
});

// Get file content with diff information for CodeEditor
router.get('/file-with-diff', async (req, res) => {
  const project = typeof req.query.project === 'string' ? req.query.project : '';
  const file = typeof req.query.file === 'string' ? req.query.file : '';

  if (!project || !file) {
    return res.status(400).json({ error: 'Project id and file path are required' });
  }

  try {
    const projectPath = await getActualProjectPath(project);

    // Validate git repository
    await validateGitRepository(projectPath);

    const {
      repositoryRootPath,
      repositoryRelativeFilePath,
    } = await resolveRepositoryFilePath(projectPath, file);

    // Check file status
    const { stdout: statusOutput } = await spawnAsync(
      'git',
      ['status', '--porcelain', '--', repositoryRelativeFilePath],
      { cwd: repositoryRootPath },
    );
    const isUntracked = statusOutput.startsWith('??');
    const isDeleted = statusOutput.trim().startsWith('D ') || statusOutput.trim().startsWith(' D');

    let currentContent = '';
    let oldContent = '';

    if (isDeleted) {
      // For deleted files, get content from HEAD
      const { stdout: headContent } = await spawnAsync(
        'git',
        ['show', `HEAD:${repositoryRelativeFilePath}`],
        { cwd: repositoryRootPath },
      );
      oldContent = headContent;
      currentContent = headContent; // Show the deleted content in editor
    } else {
      // Get current file content
      const filePath = path.join(repositoryRootPath, repositoryRelativeFilePath);
      const stats = await fs.stat(filePath);

      if (stats.isDirectory()) {
        // Cannot show content for directories
        return res.status(400).json({ error: 'Cannot show diff for directories' });
      }

      currentContent = await fs.readFile(filePath, 'utf-8');

      if (!isUntracked) {
        // Get the old content from HEAD for tracked files
        try {
          const { stdout: headContent } = await spawnAsync(
            'git',
            ['show', `HEAD:${repositoryRelativeFilePath}`],
            { cwd: repositoryRootPath },
          );
          oldContent = headContent;
        } catch (error) {
          // File might be newly added to git (staged but not committed)
          oldContent = '';
        }
      }
    }

    res.json({
      currentContent,
      oldContent,
      isDeleted,
      isUntracked
    });
  } catch (error) {
    console.error('Git file-with-diff error:', error);
    res.json({ error: getErrorMessage(error) });
  }
});

// Create initial commit
router.post('/initial-commit', async (req, res) => {
  const { project } = req.body;

  if (!project) {
    return res.status(400).json({ error: 'Project id is required' });
  }

  try {
    const projectPath = await getActualProjectPath(project);

    // Validate git repository
    await validateGitRepository(projectPath);

    // Check if there are already commits
    try {
      await spawnAsync('git', ['rev-parse', 'HEAD'], { cwd: projectPath });
      return res.status(400).json({ error: 'Repository already has commits. Use regular commit instead.' });
    } catch (error) {
      // No HEAD - this is good, we can create initial commit
    }

    // Add all files
    await spawnAsync('git', ['add', '.'], { cwd: projectPath });

    // Create initial commit
    const { stdout } = await spawnAsync('git', ['commit', '-m', 'Initial commit'], { cwd: projectPath });

    res.json({ success: true, output: stdout, message: 'Initial commit created successfully' });
  } catch (error) {
    console.error('Git initial commit error:', error);

    // Handle the case where there's nothing to commit
    if (getErrorMessage(error).includes('nothing to commit')) {
      return res.status(400).json({
        error: 'Nothing to commit',
        details: 'No files found in the repository. Add some files first.'
      });
    }

    res.status(500).json({ error: getErrorMessage(error) });
  }
});

// Commit changes
router.post('/commit', async (req, res) => {
  const { project, message, files } = req.body;

  if (!project || !message || !files || files.length === 0) {
    return res.status(400).json({ error: 'Project name, commit message, and files are required' });
  }

  try {
    const projectPath = await getActualProjectPath(project);

    // Validate git repository
    await validateGitRepository(projectPath);
    const repositoryRootPath = await getRepositoryRootPath(projectPath);

    // Stage selected files
    for (const file of files) {
      const { repositoryRelativeFilePath } = await resolveRepositoryFilePath(projectPath, file);
      await spawnAsync('git', ['add', '--', repositoryRelativeFilePath], { cwd: repositoryRootPath });
    }

    // Commit with message
    const { stdout } = await spawnAsync('git', ['commit', '-m', message], { cwd: repositoryRootPath });

    res.json({ success: true, output: stdout });
  } catch (error) {
    console.error('Git commit error:', error);
    res.status(500).json({ error: getErrorMessage(error) });
  }
});

// Stage files (git add). Mirrors what the UI shows as the "Staged" section,
// so the app's staging state and the real git index never drift apart.
router.post('/stage', async (req, res) => {
  const { project, files } = req.body;

  if (!project || !Array.isArray(files) || files.length === 0) {
    return res.status(400).json({ error: 'Project id and files are required' });
  }

  try {
    const projectPath = await getActualProjectPath(project);
    await validateGitRepository(projectPath);
    const repositoryRootPath = await getRepositoryRootPath(projectPath);

    for (const file of files) {
      const { repositoryRelativeFilePath } = await resolveRepositoryFilePath(projectPath, file);
      await spawnAsync('git', ['add', '--', repositoryRelativeFilePath], { cwd: repositoryRootPath });
    }

    res.json({ success: true });
  } catch (error) {
    console.error('Git stage error:', error);
    res.status(500).json({ error: getErrorMessage(error) });
  }
});

// Unstage files (remove from the index, keep the worktree changes)
router.post('/unstage', async (req, res) => {
  const { project, files } = req.body;

  if (!project || !Array.isArray(files) || files.length === 0) {
    return res.status(400).json({ error: 'Project id and files are required' });
  }

  try {
    const projectPath = await getActualProjectPath(project);
    await validateGitRepository(projectPath);
    const repositoryRootPath = await getRepositoryRootPath(projectPath);
    const hasCommits = await repositoryHasCommits(projectPath);

    for (const file of files) {
      const { repositoryRelativeFilePath } = await resolveRepositoryFilePath(projectPath, file);
      if (hasCommits) {
        await spawnAsync('git', ['reset', 'HEAD', '--', repositoryRelativeFilePath], { cwd: repositoryRootPath });
      } else {
        // No HEAD to reset against before the first commit; dropping the
        // index entry is the only way to unstage while keeping the file.
        await spawnAsync('git', ['rm', '--cached', '-r', '--force', '--', repositoryRelativeFilePath], { cwd: repositoryRootPath });
      }
    }

    res.json({ success: true });
  } catch (error) {
    console.error('Git unstage error:', error);
    res.status(500).json({ error: getErrorMessage(error) });
  }
});

// Revert latest local commit (keeps changes staged)
router.post('/revert-local-commit', async (req, res) => {
  const { project } = req.body;

  if (!project) {
    return res.status(400).json({ error: 'Project id is required' });
  }

  try {
    const projectPath = await getActualProjectPath(project);
    await validateGitRepository(projectPath);

    try {
      await spawnAsync('git', ['rev-parse', '--verify', 'HEAD'], { cwd: projectPath });
    } catch (error) {
      return res.status(400).json({
        error: 'No local commit to revert',
        details: 'This repository has no commit yet.',
      });
    }

    try {
      // Soft reset rewinds one commit while preserving all file changes in the index.
      await spawnAsync('git', ['reset', '--soft', 'HEAD~1'], { cwd: projectPath });
    } catch (error) {
      const errorDetails = `${getErrorStderr(error)} ${getErrorMessage(error)}`;
      const isInitialCommit = errorDetails.includes('HEAD~1') &&
        (errorDetails.includes('unknown revision') || errorDetails.includes('ambiguous argument'));

      if (!isInitialCommit) {
        throw error;
      }

      // Initial commit has no parent; deleting HEAD uncommits it and keeps files staged.
      await spawnAsync('git', ['update-ref', '-d', 'HEAD'], { cwd: projectPath });
    }

    res.json({
      success: true,
      output: 'Latest local commit reverted successfully. Changes were kept staged.',
    });
  } catch (error) {
    console.error('Git revert local commit error:', error);
    res.status(500).json({ error: getErrorMessage(error) });
  }
});

// Get list of branches
router.get('/branches', async (req, res) => {
  const project = typeof req.query.project === 'string' ? req.query.project : '';

  if (!project) {
    return res.status(400).json({ error: 'Project id is required' });
  }

  try {
    const projectPath = await getActualProjectPath(project);

    // Validate git repository
    await validateGitRepository(projectPath);

    // Get all branches
    const { stdout } = await spawnAsync('git', ['branch', '-a'], { cwd: projectPath });

    const rawLines = stdout
      .split('\n')
      .map(b => b.trim())
      .filter(b => b && !b.includes('->'));

    // Local branches (may start with '* ' for current)
    const localBranches = rawLines
      .filter(b => !b.startsWith('remotes/'))
      .map(b => (b.startsWith('* ') ? b.substring(2) : b));

    // Remote branches — strip 'remotes/<remote>/' prefix
    const remoteBranches = rawLines
      .filter(b => b.startsWith('remotes/'))
      .map(b => b.replace(/^remotes\/[^/]+\//, ''))
      .filter(name => !localBranches.includes(name)); // skip if already a local branch

    // Backward-compat flat list (local + unique remotes, deduplicated)
    const branches = [...localBranches, ...remoteBranches]
      .filter((b, i, arr) => arr.indexOf(b) === i);

    res.json({ branches, localBranches, remoteBranches });
  } catch (error) {
    console.error('Git branches error:', error);
    res.json({ error: getErrorMessage(error) });
  }
});

// Checkout branch
router.post('/checkout', async (req, res) => {
  const { project, branch } = req.body;

  if (!project || !branch) {
    return res.status(400).json({ error: 'Project id and branch are required' });
  }

  try {
    const projectPath = await getActualProjectPath(project);

    // Checkout the branch. Trailing `--` marks the end of pathspecs so `branch`
    // is always treated as a ref, never as an option (defense-in-depth on top of
    // validateBranchName). Note: for `checkout`/`show` the `--` must follow the
    // ref — a leading `--` would make git read the ref as a file path instead.
    validateBranchName(branch);
    const { stdout } = await spawnAsync('git', ['checkout', branch, '--'], { cwd: projectPath });

    res.json({ success: true, output: stdout });
  } catch (error) {
    console.error('Git checkout error:', error);
    res.status(500).json({ error: getErrorMessage(error) });
  }
});

// Create new branch
router.post('/create-branch', async (req, res) => {
  const { project, branch } = req.body;

  if (!project || !branch) {
    return res.status(400).json({ error: 'Project id and branch name are required' });
  }

  try {
    const projectPath = await getActualProjectPath(project);

    // Create and checkout new branch. Trailing `--` (after the new branch name)
    // ends option/pathspec parsing so the name cannot be read as an option.
    validateBranchName(branch);
    const { stdout } = await spawnAsync('git', ['checkout', '-b', branch, '--'], { cwd: projectPath });

    res.json({ success: true, output: stdout });
  } catch (error) {
    console.error('Git create branch error:', error);
    res.status(500).json({ error: getErrorMessage(error) });
  }
});

// Delete a local branch
router.post('/delete-branch', async (req, res) => {
  const { project, branch } = req.body;

  if (!project || !branch) {
    return res.status(400).json({ error: 'Project id and branch name are required' });
  }

  try {
    const projectPath = await getActualProjectPath(project);
    await validateGitRepository(projectPath);

    // Safety: cannot delete the currently checked-out branch
    const { stdout: currentBranch } = await spawnAsync('git', ['branch', '--show-current'], { cwd: projectPath });
    if (currentBranch.trim() === branch) {
      return res.status(400).json({ error: 'Cannot delete the currently checked-out branch' });
    }

    // `git branch` takes no pathspec, so a leading `--` here is a pure
    // end-of-options marker: `branch` after it is always treated as a branch
    // name, never as an option flag.
    const { stdout } = await spawnAsync('git', ['branch', '-d', '--', branch], { cwd: projectPath });
    res.json({ success: true, output: stdout });
  } catch (error) {
    console.error('Git delete branch error:', error);
    res.status(500).json({ error: getErrorMessage(error) });
  }
});

// Fields are joined with the ASCII unit separator so pipes (or anything else
// typed into a commit subject) cannot break parsing.
const GIT_LOG_FIELD_SEPARATOR = '\u001f';
const GIT_LOG_PRETTY_FORMAT = '%H%x1f%P%x1f%D%x1f%an%x1f%ae%x1f%ad%x1f%s';

/**
 * Parses `git log --shortstat` output produced with GIT_LOG_PRETTY_FORMAT.
 *
 * Each commit is one format line (hash, parent hashes, ref decorations,
 * author, email, date, subject) optionally followed by its `--shortstat`
 * summary line ("N files changed, ..."). Parents and refs feed the commit
 * graph rendered by the History view; merge commits carry no shortstat line,
 * so their `stats` stays empty.
 *
 * Exported for tests.
 */
export function parseGitLogWithStats(stdout: string) {
  const commits = [];

  for (const rawLine of stdout.split('\n')) {
    const line = rawLine.trimEnd();
    if (!line.trim()) continue;

    if (line.includes(GIT_LOG_FIELD_SEPARATOR)) {
      const [hash, parents, refs, author, email, date, ...messageParts] = line.split(GIT_LOG_FIELD_SEPARATOR);
      commits.push({
        hash,
        parents: parents ? parents.split(' ').filter(Boolean) : [],
        // `%D` decorations, e.g. "HEAD -> main", "origin/main", "tag: v1.0".
        refs: refs ? refs.split(', ').filter(Boolean) : [],
        author,
        email,
        date,
        message: messageParts.join(GIT_LOG_FIELD_SEPARATOR),
        stats: ''
      });
      continue;
    }

    if (commits.length > 0 && /files? changed/.test(line)) {
      commits[commits.length - 1].stats = line.trim();
    }
  }

  return commits;
}

// Get recent commits (across all branches, in graph order)
router.get('/commits', async (req, res) => {
  const project = typeof req.query.project === 'string' ? req.query.project : '';
  const limit = typeof req.query.limit === 'string' ? req.query.limit : '10';

  if (!project) {
    return res.status(400).json({ error: 'Project id is required' });
  }

  try {
    const projectPath = await getActualProjectPath(project);
    await validateGitRepository(projectPath);
    const parsedLimit = Number.parseInt(String(limit), 10);
    const safeLimit = Number.isFinite(parsedLimit) && parsedLimit > 0
      ? Math.min(parsedLimit, 100)
      : 10;

    // Branches/remotes/tags (not --all, which would drag in refs/stash) with
    // `--topo-order` guarantee children appear before their parents across
    // every branch, which the frontend lane-assignment relies on.
    // `--shortstat` replaces the previous per-commit `git show --stat` calls.
    const { stdout } = await spawnAsync(
      'git',
      [
        'log',
        '--branches',
        '--remotes',
        '--tags',
        '--topo-order',
        '--shortstat',
        `--pretty=format:${GIT_LOG_PRETTY_FORMAT}`,
        '--date=iso-strict',
        '-n', String(safeLimit)
      ],
      { cwd: projectPath },
    );

    res.json({ commits: parseGitLogWithStats(stdout) });
  } catch (error) {
    console.error('Git commits error:', error);
    res.json({ error: getErrorMessage(error) });
  }
});

// Get diff for a specific commit
router.get('/commit-diff', async (req, res) => {
  const project = typeof req.query.project === 'string' ? req.query.project : '';
  const commit = typeof req.query.commit === 'string' ? req.query.commit : '';

  if (!project || !commit) {
    return res.status(400).json({ error: 'Project id and commit hash are required' });
  }

  try {
    const projectPath = await getActualProjectPath(project);

    // Validate commit reference (defense-in-depth)
    validateCommitRef(commit);

    // Get diff for the commit. Trailing `--` (after the ref) ends pathspec
    // parsing so `commit` is always treated as a revision, never as an option.
    // The `--` must follow the ref here: a leading `--` would make git treat the
    // ref as a file path and show the wrong thing.
    const { stdout } = await spawnAsync(
      'git', ['show', commit, '--'],
      { cwd: projectPath }
    );

    const isTruncated = stdout.length > COMMIT_DIFF_CHARACTER_LIMIT;
    const diff = isTruncated
      ? `${stdout.slice(0, COMMIT_DIFF_CHARACTER_LIMIT)}\n\n... Diff truncated to keep the UI responsive ...`
      : stdout;

    res.json({ diff, isTruncated });
  } catch (error) {
    console.error('Git commit diff error:', error);
    res.json({ error: getErrorMessage(error) });
  }
});

// Generate commit message based on staged changes using AI
router.post('/generate-commit-message', async (req, res) => {
  const { project, files, provider = 'claude' } = req.body;

  if (!project || !files || files.length === 0) {
    return res.status(400).json({ error: 'Project id and files are required' });
  }

  // Validate provider
  if (!['claude', 'cursor'].includes(provider)) {
    return res.status(400).json({ error: 'provider must be "claude" or "cursor"' });
  }

  try {
    const projectPath = await getActualProjectPath(project);
    await validateGitRepository(projectPath);
    const repositoryRootPath = await getRepositoryRootPath(projectPath);

    // Get diff for selected files
    let diffContext = '';
    for (const file of files) {
      try {
        const { repositoryRelativeFilePath } = await resolveRepositoryFilePath(projectPath, file);
        const { stdout } = await spawnAsync(
          'git', ['diff', 'HEAD', '--', repositoryRelativeFilePath],
          { cwd: repositoryRootPath }
        );
        if (stdout) {
          diffContext += `\n--- ${repositoryRelativeFilePath} ---\n${stdout}`;
        }
      } catch (error) {
        console.error(`Error getting diff for ${file}:`, error);
      }
    }

    // If no diff found, might be untracked files
    if (!diffContext.trim()) {
      // Try to get content of untracked files
      for (const file of files) {
        try {
          const { repositoryRelativeFilePath } = await resolveRepositoryFilePath(projectPath, file);
          const filePath = path.join(repositoryRootPath, repositoryRelativeFilePath);
          const stats = await fs.stat(filePath);

          if (!stats.isDirectory()) {
            const content = await fs.readFile(filePath, 'utf-8');
            diffContext += `\n--- ${repositoryRelativeFilePath} (new file) ---\n${content.substring(0, 1000)}\n`;
          } else {
            diffContext += `\n--- ${repositoryRelativeFilePath} (new directory) ---\n`;
          }
        } catch (error) {
          console.error(`Error reading file ${file}:`, error);
        }
      }
    }

    // Generate commit message using AI
    const message = await generateCommitMessageWithAI(files, diffContext, provider, projectPath);

    res.json({ message });
  } catch (error) {
    console.error('Generate commit message error:', error);
    res.status(500).json({ error: getErrorMessage(error) });
  }
});


// Get remote status (ahead/behind commits with smart remote detection)
router.use(remoteRoutes);

router.use(workingTreeRoutes);

export default router;
