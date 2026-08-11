import fs, { promises as fsPromises } from 'node:fs';
import path from 'node:path';

import express from 'express';

import { WORKSPACES_ROOT, validateWorkspacePath } from '@/shared/utils.js';
import { expandWorkspacePath, getFileTree } from '@/modules/files/files.service.js';

const router = express.Router();

function readOptionalQueryString(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && typeof value[0] === 'string') return value[0];
  return null;
}

router.get('/browse-filesystem', async (req, res) => {
  try {
    const dirPath = readOptionalQueryString(req.query.path);
    const defaultRoot = WORKSPACES_ROOT;
    let targetPath = dirPath ? expandWorkspacePath(dirPath) : defaultRoot;
    targetPath = path.resolve(targetPath);

    const validation = await validateWorkspacePath(targetPath);
    if (!validation.valid) return res.status(403).json({ error: validation.error });
    const resolvedPath = validation.resolvedPath || targetPath;

    try {
      await fs.promises.access(resolvedPath);
      const stats = await fs.promises.stat(resolvedPath);
      if (!stats.isDirectory()) return res.status(400).json({ error: 'Path is not a directory' });
    } catch {
      return res.status(404).json({ error: 'Directory not accessible' });
    }

    const fileTree = await getFileTree(resolvedPath, 1, 0, false);
    const directories = fileTree
      .filter((item) => item.type === 'directory')
      .map((item) => ({ path: item.path, name: item.name, type: 'directory' as const }))
      .sort((left, right) => {
        const leftHidden = left.name.startsWith('.');
        const rightHidden = right.name.startsWith('.');
        if (leftHidden && !rightHidden) return 1;
        if (!leftHidden && rightHidden) return -1;
        return left.name.localeCompare(right.name);
      });

    let resolvedWorkspaceRoot = defaultRoot;
    try {
      resolvedWorkspaceRoot = await fsPromises.realpath(defaultRoot);
    } catch {
      // Keep the configured root if it has not been created yet.
    }

    const suggestions = resolvedPath === resolvedWorkspaceRoot
      ? [
          ...directories.filter((directory) => ['Desktop', 'Documents', 'Projects', 'Development', 'Dev', 'Code', 'workspace'].includes(directory.name)),
          ...directories.filter((directory) => !['Desktop', 'Documents', 'Projects', 'Development', 'Dev', 'Code', 'workspace'].includes(directory.name)),
        ]
      : directories;

    return res.json({ path: resolvedPath, suggestions });
  } catch (error) {
    console.error('Error browsing filesystem:', error);
    return res.status(500).json({ error: 'Failed to browse filesystem' });
  }
});

router.post('/create-folder', async (req, res) => {
  try {
    const folderPath = typeof req.body?.path === 'string' ? req.body.path : '';
    if (!folderPath) return res.status(400).json({ error: 'Path is required' });

    const expandedPath = expandWorkspacePath(folderPath);
    const resolvedInput = path.resolve(expandedPath);
    const validation = await validateWorkspacePath(resolvedInput);
    if (!validation.valid) return res.status(403).json({ error: validation.error });
    const targetPath = validation.resolvedPath || resolvedInput;

    try {
      await fs.promises.access(path.dirname(targetPath));
    } catch {
      return res.status(404).json({ error: 'Parent directory does not exist' });
    }

    try {
      await fs.promises.access(targetPath);
      return res.status(409).json({ error: 'Folder already exists' });
    } catch {
      // The target is available for creation.
    }

    await fs.promises.mkdir(targetPath, { recursive: false });
    return res.json({ success: true, path: targetPath, message: 'Folder created successfully' });
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException;
    console.error('Error creating folder:', error);
    if (nodeError.code === 'EACCES') return res.status(403).json({ error: 'Permission denied' });
    return res.status(500).json({ error: nodeError.message || 'Failed to create folder' });
  }
});

export default router;
