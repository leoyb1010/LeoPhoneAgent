import express from 'express';

import { logger } from '@/modules/logging/index.js';

import {
  getActualProjectPath,
  getCurrentBranchName,
  repositoryHasCommits,
  spawnAsync,
  validateBranchName,
  validateGitRepository,
  validateRemoteName,
} from './git.service.js';

const router = express.Router();

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

router.get('/remote-status', async (req, res) => {
  const project = typeof req.query.project === 'string' ? req.query.project : '';

  if (!project) {
    return res.status(400).json({ error: 'Project id is required' });
  }

  try {
    const projectPath = await getActualProjectPath(project);
    await validateGitRepository(projectPath);

    const branch = await getCurrentBranchName(projectPath);
    const hasCommits = await repositoryHasCommits(projectPath);

    const { stdout: remoteOutput } = await spawnAsync('git', ['remote'], { cwd: projectPath });
    const remotes = remoteOutput.trim().split('\n').filter(r => r.trim());
    const hasRemote = remotes.length > 0;
    const fallbackRemoteName = hasRemote
      ? (remotes.includes('origin') ? 'origin' : remotes[0])
      : null;

    // Repositories initialized with `git init` can have a branch but no commits.
    // Return a non-error state so the UI can show the initial-commit workflow.
    if (!hasCommits) {
      return res.json({
        hasRemote,
        hasUpstream: false,
        branch,
        remoteName: fallbackRemoteName,
        ahead: 0,
        behind: 0,
        isUpToDate: false,
        message: 'Repository has no commits yet'
      });
    }

    // Check if there's a remote tracking branch (smart detection)
    let trackingBranch;
    let remoteName;
    try {
      const { stdout } = await spawnAsync('git', ['rev-parse', '--abbrev-ref', `${branch}@{upstream}`], { cwd: projectPath });
      trackingBranch = stdout.trim();
      remoteName = trackingBranch.split('/')[0]; // Extract remote name (e.g., "origin/main" -> "origin")
    } catch (error) {
      return res.json({
        hasRemote,
        hasUpstream: false,
        branch,
        remoteName: fallbackRemoteName,
        message: 'No remote tracking branch configured'
      });
    }

    // Get ahead/behind counts
    const { stdout: countOutput } = await spawnAsync(
      'git', ['rev-list', '--count', '--left-right', `${trackingBranch}...HEAD`],
      { cwd: projectPath }
    );

    const [behind, ahead] = countOutput.trim().split('\t').map(Number);

    res.json({
      hasRemote: true,
      hasUpstream: true,
      branch,
      remoteBranch: trackingBranch,
      remoteName,
      ahead: ahead || 0,
      behind: behind || 0,
      isUpToDate: ahead === 0 && behind === 0
    });
  } catch (error) {
    console.error('Git remote status error:', error);
    res.json({ error: getErrorMessage(error) });
  }
});

// Fetch from remote (using smart remote detection)
router.post('/fetch', async (req, res) => {
  const { project } = req.body;

  if (!project) {
    return res.status(400).json({ error: 'Project id is required' });
  }

  try {
    const projectPath = await getActualProjectPath(project);
    await validateGitRepository(projectPath);

    // Get current branch and its upstream remote
    const branch = await getCurrentBranchName(projectPath);

    let remoteName = 'origin'; // fallback
    try {
      const { stdout } = await spawnAsync('git', ['rev-parse', '--abbrev-ref', `${branch}@{upstream}`], { cwd: projectPath });
      remoteName = stdout.trim().split('/')[0]; // Extract remote name
    } catch (error) {
      // No upstream, try to fetch from origin anyway
      logger.info('No upstream configured, using origin as fallback');
    }

    validateRemoteName(remoteName);
    const { stdout } = await spawnAsync('git', ['fetch', remoteName], { cwd: projectPath });

    res.json({ success: true, output: stdout || 'Fetch completed successfully', remoteName });
  } catch (error) {
    console.error('Git fetch error:', error);
    res.status(500).json({
      error: 'Fetch failed',
      details: getErrorMessage(error).includes('Could not resolve hostname')
        ? 'Unable to connect to remote repository. Check your internet connection.'
        : getErrorMessage(error).includes('fatal: \'origin\' does not appear to be a git repository')
        ? 'No remote repository configured. Add a remote with: git remote add origin <url>'
        : getErrorMessage(error)
    });
  }
});

// Pull from remote (fetch + merge using smart remote detection)
router.post('/pull', async (req, res) => {
  const { project } = req.body;

  if (!project) {
    return res.status(400).json({ error: 'Project id is required' });
  }

  try {
    const projectPath = await getActualProjectPath(project);
    await validateGitRepository(projectPath);

    // Get current branch and its upstream remote
    const branch = await getCurrentBranchName(projectPath);

    let remoteName = 'origin'; // fallback
    let remoteBranch = branch; // fallback
    try {
      const { stdout } = await spawnAsync('git', ['rev-parse', '--abbrev-ref', `${branch}@{upstream}`], { cwd: projectPath });
      const tracking = stdout.trim();
      remoteName = tracking.split('/')[0]; // Extract remote name
      remoteBranch = tracking.split('/').slice(1).join('/'); // Extract branch name
    } catch (error) {
      // No upstream, use fallback
      logger.info('No upstream configured, using origin/branch as fallback');
    }

    validateRemoteName(remoteName);
    validateBranchName(remoteBranch);
    const { stdout } = await spawnAsync('git', ['pull', remoteName, remoteBranch], { cwd: projectPath });

    res.json({
      success: true,
      output: stdout || 'Pull completed successfully',
      remoteName,
      remoteBranch
    });
  } catch (error) {
    console.error('Git pull error:', error);

    // Enhanced error handling for common pull scenarios
    let errorMessage = 'Pull failed';
    let details = getErrorMessage(error);

    if (getErrorMessage(error).includes('CONFLICT')) {
      errorMessage = 'Merge conflicts detected';
      details = 'Pull created merge conflicts. Please resolve conflicts manually in the editor, then commit the changes.';
    } else if (getErrorMessage(error).includes('Please commit your changes or stash them')) {
      errorMessage = 'Uncommitted changes detected';
      details = 'Please commit or stash your local changes before pulling.';
    } else if (getErrorMessage(error).includes('Could not resolve hostname')) {
      errorMessage = 'Network error';
      details = 'Unable to connect to remote repository. Check your internet connection.';
    } else if (getErrorMessage(error).includes('fatal: \'origin\' does not appear to be a git repository')) {
      errorMessage = 'Remote not configured';
      details = 'No remote repository configured. Add a remote with: git remote add origin <url>';
    } else if (getErrorMessage(error).includes('diverged')) {
      errorMessage = 'Branches have diverged';
      details = 'Your local branch and remote branch have diverged. Consider fetching first to review changes.';
    }

    res.status(500).json({
      error: errorMessage,
      details: details
    });
  }
});

// Push commits to remote repository
router.post('/push', async (req, res) => {
  const { project } = req.body;

  if (!project) {
    return res.status(400).json({ error: 'Project id is required' });
  }

  try {
    const projectPath = await getActualProjectPath(project);
    await validateGitRepository(projectPath);

    // Get current branch and its upstream remote
    const branch = await getCurrentBranchName(projectPath);

    let remoteName = 'origin'; // fallback
    let remoteBranch = branch; // fallback
    try {
      const { stdout } = await spawnAsync('git', ['rev-parse', '--abbrev-ref', `${branch}@{upstream}`], { cwd: projectPath });
      const tracking = stdout.trim();
      remoteName = tracking.split('/')[0]; // Extract remote name
      remoteBranch = tracking.split('/').slice(1).join('/'); // Extract branch name
    } catch (error) {
      // No upstream, use fallback
      logger.info('No upstream configured, using origin/branch as fallback');
    }

    validateRemoteName(remoteName);
    validateBranchName(remoteBranch);
    const { stdout } = await spawnAsync('git', ['push', remoteName, remoteBranch], { cwd: projectPath });

    res.json({
      success: true,
      output: stdout || 'Push completed successfully',
      remoteName,
      remoteBranch
    });
  } catch (error) {
    console.error('Git push error:', error);

    // Enhanced error handling for common push scenarios
    let errorMessage = 'Push failed';
    let details = getErrorMessage(error);

    if (getErrorMessage(error).includes('rejected')) {
      errorMessage = 'Push rejected';
      details = 'The remote has newer commits. Pull first to merge changes before pushing.';
    } else if (getErrorMessage(error).includes('non-fast-forward')) {
      errorMessage = 'Non-fast-forward push';
      details = 'Your branch is behind the remote. Pull the latest changes first.';
    } else if (getErrorMessage(error).includes('Could not resolve hostname')) {
      errorMessage = 'Network error';
      details = 'Unable to connect to remote repository. Check your internet connection.';
    } else if (getErrorMessage(error).includes('fatal: \'origin\' does not appear to be a git repository')) {
      errorMessage = 'Remote not configured';
      details = 'No remote repository configured. Add a remote with: git remote add origin <url>';
    } else if (getErrorMessage(error).includes('Permission denied')) {
      errorMessage = 'Authentication failed';
      details = 'Permission denied. Check your credentials or SSH keys.';
    } else if (getErrorMessage(error).includes('no upstream branch')) {
      errorMessage = 'No upstream branch';
      details = 'No upstream branch configured. Use: git push --set-upstream origin <branch>';
    }

    res.status(500).json({
      error: errorMessage,
      details: details
    });
  }
});

// Publish branch to remote (set upstream and push)
router.post('/publish', async (req, res) => {
  const { project, branch } = req.body;

  if (!project || !branch) {
    return res.status(400).json({ error: 'Project id and branch are required' });
  }

  try {
    const projectPath = await getActualProjectPath(project);
    await validateGitRepository(projectPath);

    // Validate branch name
    validateBranchName(branch);

    // Get current branch to verify it matches the requested branch
    const currentBranchName = await getCurrentBranchName(projectPath);

    if (currentBranchName !== branch) {
      return res.status(400).json({
        error: `Branch mismatch. Current branch is ${currentBranchName}, but trying to publish ${branch}`
      });
    }

    // Check if remote exists
    let remoteName = 'origin';
    try {
      const { stdout } = await spawnAsync('git', ['remote'], { cwd: projectPath });
      const remotes = stdout.trim().split('\n').filter(r => r.trim());
      if (remotes.length === 0) {
        return res.status(400).json({
          error: 'No remote repository configured. Add a remote with: git remote add origin <url>'
        });
      }
      remoteName = remotes.includes('origin') ? 'origin' : remotes[0];
    } catch (error) {
      return res.status(400).json({
        error: 'No remote repository configured. Add a remote with: git remote add origin <url>'
      });
    }

    // Publish the branch (set upstream and push)
    validateRemoteName(remoteName);
    const { stdout } = await spawnAsync('git', ['push', '--set-upstream', remoteName, branch], { cwd: projectPath });

    res.json({
      success: true,
      output: stdout || 'Branch published successfully',
      remoteName,
      branch
    });
  } catch (error) {
    console.error('Git publish error:', error);

    // Enhanced error handling for common publish scenarios
    let errorMessage = 'Publish failed';
    let details = getErrorMessage(error);

    if (getErrorMessage(error).includes('rejected')) {
      errorMessage = 'Publish rejected';
      details = 'The remote branch already exists and has different commits. Use push instead.';
    } else if (getErrorMessage(error).includes('Could not resolve hostname')) {
      errorMessage = 'Network error';
      details = 'Unable to connect to remote repository. Check your internet connection.';
    } else if (getErrorMessage(error).includes('Permission denied')) {
      errorMessage = 'Authentication failed';
      details = 'Permission denied. Check your credentials or SSH keys.';
    } else if (getErrorMessage(error).includes('fatal:') && getErrorMessage(error).includes('does not appear to be a git repository')) {
      errorMessage = 'Remote not configured';
      details = 'Remote repository not properly configured. Check your remote URL.';
    }

    res.status(500).json({
      error: errorMessage,
      details: details
    });
  }
});

// Discard changes for a specific file

export default router;
