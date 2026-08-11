import { promises as fsPromises } from 'node:fs';
import path from 'node:path';

import express from 'express';

import { projectsDb } from '@/modules/database/index.js';
import {
  assertRealPathWithinRoot,
  validateFilename,
  validatePathInProject,
} from '@/modules/files/files.service.js';

const router = express.Router();

type FileEntryType = 'file' | 'directory';

function toNodeError(error: unknown): NodeJS.ErrnoException {
  return error instanceof Error ? error as NodeJS.ErrnoException : new Error(String(error));
}

router.post('/projects/:projectId/files/create', async (req, res) => {
  try {
    const parentPath = typeof req.body?.path === 'string' ? req.body.path : '';
    const type = req.body?.type as FileEntryType | undefined;
    const name = typeof req.body?.name === 'string' ? req.body.name : '';
    if (!name || !type) return res.status(400).json({ error: 'Name and type are required' });
    if (type !== 'file' && type !== 'directory') {
      return res.status(400).json({ error: 'Type must be "file" or "directory"' });
    }

    const nameValidation = validateFilename(name);
    if (!nameValidation.valid) return res.status(400).json({ error: nameValidation.error });

    const projectRoot = await projectsDb.getProjectPathById(req.params.projectId);
    if (!projectRoot) return res.status(404).json({ error: 'Project not found' });

    const targetPath = parentPath ? path.join(parentPath, name) : name;
    const validation = validatePathInProject(projectRoot, targetPath);
    if (!validation.valid || !validation.resolved) {
      return res.status(403).json({ error: validation.error || 'Invalid target path' });
    }

    const realCheck = await assertRealPathWithinRoot(projectRoot, validation.resolved, { allowMissing: true });
    if (!realCheck.valid || !realCheck.realPath) {
      return res.status(403).json({ error: realCheck.error || 'Invalid target path' });
    }
    const resolvedPath = realCheck.realPath;

    try {
      await fsPromises.access(resolvedPath);
      return res.status(409).json({ error: `${type === 'file' ? 'File' : 'Directory'} already exists` });
    } catch {
      // The target is available.
    }

    if (type === 'directory') {
      await fsPromises.mkdir(resolvedPath, { recursive: false });
    } else {
      await fsPromises.mkdir(path.dirname(resolvedPath), { recursive: true });
      await fsPromises.writeFile(resolvedPath, '', 'utf8');
    }

    return res.json({
      success: true,
      path: resolvedPath,
      name,
      type,
      message: `${type === 'file' ? 'File' : 'Directory'} created successfully`,
    });
  } catch (error) {
    const nodeError = toNodeError(error);
    console.error('Error creating file/directory:', error);
    if (nodeError.code === 'EACCES') return res.status(403).json({ error: 'Permission denied' });
    if (nodeError.code === 'ENOENT') return res.status(404).json({ error: 'Parent directory not found' });
    return res.status(500).json({ error: nodeError.message });
  }
});

router.put('/projects/:projectId/files/rename', async (req, res) => {
  try {
    const oldPath = typeof req.body?.oldPath === 'string' ? req.body.oldPath : '';
    const newName = typeof req.body?.newName === 'string' ? req.body.newName : '';
    if (!oldPath || !newName) return res.status(400).json({ error: 'oldPath and newName are required' });

    const nameValidation = validateFilename(newName);
    if (!nameValidation.valid) return res.status(400).json({ error: nameValidation.error });

    const projectRoot = await projectsDb.getProjectPathById(req.params.projectId);
    if (!projectRoot) return res.status(404).json({ error: 'Project not found' });

    const oldValidation = validatePathInProject(projectRoot, oldPath);
    if (!oldValidation.valid || !oldValidation.resolved) {
      return res.status(403).json({ error: oldValidation.error || 'Invalid source path' });
    }
    const oldRealCheck = await assertRealPathWithinRoot(projectRoot, oldValidation.resolved);
    if (!oldRealCheck.valid || !oldRealCheck.realPath) {
      return res.status(403).json({ error: oldRealCheck.error || 'Invalid source path' });
    }
    const resolvedOldPath = oldRealCheck.realPath;

    const newValidation = validatePathInProject(projectRoot, path.join(path.dirname(resolvedOldPath), newName));
    if (!newValidation.valid || !newValidation.resolved) {
      return res.status(403).json({ error: newValidation.error || 'Invalid destination path' });
    }
    const newRealCheck = await assertRealPathWithinRoot(projectRoot, newValidation.resolved, { allowMissing: true });
    if (!newRealCheck.valid || !newRealCheck.realPath) {
      return res.status(403).json({ error: newRealCheck.error || 'Invalid destination path' });
    }
    const resolvedNewPath = newRealCheck.realPath;

    try {
      await fsPromises.access(resolvedNewPath);
      return res.status(409).json({ error: 'A file or directory with this name already exists' });
    } catch {
      // The destination is available.
    }

    await fsPromises.rename(resolvedOldPath, resolvedNewPath);
    return res.json({ success: true, oldPath: resolvedOldPath, newPath: resolvedNewPath, newName, message: 'Renamed successfully' });
  } catch (error) {
    const nodeError = toNodeError(error);
    console.error('Error renaming file/directory:', error);
    if (nodeError.code === 'EACCES') return res.status(403).json({ error: 'Permission denied' });
    if (nodeError.code === 'ENOENT') return res.status(404).json({ error: 'File or directory not found' });
    if (nodeError.code === 'EXDEV') return res.status(400).json({ error: 'Cannot move across different filesystems' });
    return res.status(500).json({ error: nodeError.message });
  }
});

router.delete('/projects/:projectId/files', async (req, res) => {
  try {
    const targetPath = typeof req.body?.path === 'string' ? req.body.path : '';
    if (!targetPath) return res.status(400).json({ error: 'Path is required' });

    const projectRoot = await projectsDb.getProjectPathById(req.params.projectId);
    if (!projectRoot) return res.status(404).json({ error: 'Project not found' });

    const validation = validatePathInProject(projectRoot, targetPath);
    if (!validation.valid || !validation.resolved) {
      return res.status(403).json({ error: validation.error || 'Invalid target path' });
    }
    const resolvedPath = validation.resolved;

    const parentRealCheck = await assertRealPathWithinRoot(projectRoot, path.dirname(resolvedPath));
    if (!parentRealCheck.valid) {
      return res.status(403).json({ error: parentRealCheck.error || 'Invalid target path' });
    }

    let stats;
    try {
      stats = await fsPromises.lstat(resolvedPath);
    } catch {
      return res.status(404).json({ error: 'File or directory not found' });
    }

    if (stats.isSymbolicLink()) {
      await fsPromises.unlink(resolvedPath);
      return res.json({ success: true, path: resolvedPath, message: 'Symbolic link deleted' });
    }
    if (resolvedPath === path.resolve(projectRoot)) {
      return res.status(403).json({ error: 'Cannot delete project root directory' });
    }

    if (stats.isDirectory()) await fsPromises.rm(resolvedPath, { recursive: true, force: true });
    else await fsPromises.unlink(resolvedPath);

    return res.json({
      success: true,
      path: resolvedPath,
      type: stats.isDirectory() ? 'directory' : 'file',
      message: 'Deleted successfully',
    });
  } catch (error) {
    const nodeError = toNodeError(error);
    console.error('Error deleting file/directory:', error);
    if (nodeError.code === 'EACCES') return res.status(403).json({ error: 'Permission denied' });
    if (nodeError.code === 'ENOENT') return res.status(404).json({ error: 'File or directory not found' });
    if (nodeError.code === 'ENOTEMPTY') return res.status(400).json({ error: 'Directory is not empty' });
    return res.status(500).json({ error: nodeError.message });
  }
});

export default router;
