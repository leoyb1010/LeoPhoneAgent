import path from 'node:path';
import { promises as fs } from 'node:fs';

import express from 'express';

import {
  getActualProjectPath,
  resolveRepositoryFilePath,
  spawnAsync,
  validateGitRepository,
} from './git.service.js';

const router = express.Router();

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

router.post('/discard', async (req, res) => {
  const project = typeof req.body?.project === 'string' ? req.body.project : '';
  const file = typeof req.body?.file === 'string' ? req.body.file : '';

  if (!project || !file) {
    return res.status(400).json({ error: 'Project id and file path are required' });
  }

  try {
    const projectPath = await getActualProjectPath(project);
    await validateGitRepository(projectPath);
    const {
      repositoryRootPath,
      repositoryRelativeFilePath,
    } = await resolveRepositoryFilePath(projectPath, file);

    // Check file status to determine correct discard command
    const { stdout: statusOutput } = await spawnAsync(
      'git',
      ['status', '--porcelain', '--', repositoryRelativeFilePath],
      { cwd: repositoryRootPath },
    );

    if (!statusOutput.trim()) {
      return res.status(400).json({ error: 'No changes to discard for this file' });
    }

    const status = statusOutput.substring(0, 2);

    if (status === '??') {
      // Untracked file or directory - delete it
      const filePath = path.join(repositoryRootPath, repositoryRelativeFilePath);
      const stats = await fs.stat(filePath);

      if (stats.isDirectory()) {
        await fs.rm(filePath, { recursive: true, force: true });
      } else {
        await fs.unlink(filePath);
      }
    } else if (status.includes('M') || status.includes('D')) {
      // Modified or deleted file - restore from HEAD
      await spawnAsync('git', ['restore', '--', repositoryRelativeFilePath], { cwd: repositoryRootPath });
    } else if (status.includes('A')) {
      // Added file - unstage it
      await spawnAsync('git', ['reset', 'HEAD', '--', repositoryRelativeFilePath], { cwd: repositoryRootPath });
    }

    res.json({ success: true, message: `Changes discarded for ${repositoryRelativeFilePath}` });
  } catch (error) {
    console.error('Git discard error:', error);
    res.status(500).json({ error: errorMessage(error) });
  }
});

// Delete untracked file
router.post('/delete-untracked', async (req, res) => {
  const project = typeof req.body?.project === 'string' ? req.body.project : '';
  const file = typeof req.body?.file === 'string' ? req.body.file : '';

  if (!project || !file) {
    return res.status(400).json({ error: 'Project id and file path are required' });
  }

  try {
    const projectPath = await getActualProjectPath(project);
    await validateGitRepository(projectPath);
    const {
      repositoryRootPath,
      repositoryRelativeFilePath,
    } = await resolveRepositoryFilePath(projectPath, file);

    // Check if file is actually untracked
    const { stdout: statusOutput } = await spawnAsync(
      'git',
      ['status', '--porcelain', '--', repositoryRelativeFilePath],
      { cwd: repositoryRootPath },
    );

    if (!statusOutput.trim()) {
      return res.status(400).json({ error: 'File is not untracked or does not exist' });
    }

    const status = statusOutput.substring(0, 2);

    if (status !== '??') {
      return res.status(400).json({ error: 'File is not untracked. Use discard for tracked files.' });
    }

    // Delete the untracked file or directory
    const filePath = path.join(repositoryRootPath, repositoryRelativeFilePath);
    const stats = await fs.stat(filePath);

    if (stats.isDirectory()) {
      // Use rm with recursive option for directories
      await fs.rm(filePath, { recursive: true, force: true });
      res.json({ success: true, message: `Untracked directory ${repositoryRelativeFilePath} deleted successfully` });
    } else {
      await fs.unlink(filePath);
      res.json({ success: true, message: `Untracked file ${repositoryRelativeFilePath} deleted successfully` });
    }
  } catch (error) {
    console.error('Git delete untracked error:', error);
    res.status(500).json({ error: errorMessage(error) });
  }
});


export default router;
