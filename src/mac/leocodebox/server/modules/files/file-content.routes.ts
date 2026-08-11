import fs, { promises as fsPromises } from 'node:fs';
import path from 'node:path';

import express from 'express';
import mime from 'mime-types';

import { projectsDb } from '@/modules/database/index.js';
import { assertRealPathWithinRoot, getFileTree } from '@/modules/files/files.service.js';

const router = express.Router();

function readQueryString(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && typeof value[0] === 'string') return value[0];
  return '';
}

function toNodeError(error: unknown): NodeJS.ErrnoException {
  return error instanceof Error ? error as NodeJS.ErrnoException : new Error(String(error));
}

function resolveProjectFile(projectRoot: string, filePath: string): string | null {
  const resolved = path.isAbsolute(filePath)
    ? path.resolve(filePath)
    : path.resolve(projectRoot, filePath);
  const normalizedRoot = `${path.resolve(projectRoot)}${path.sep}`;
  return resolved.startsWith(normalizedRoot) ? resolved : null;
}

router.get('/projects/:projectId/file', async (req, res) => {
  try {
    const filePath = readQueryString(req.query.filePath);
    if (!filePath) return res.status(400).json({ error: 'Invalid file path' });

    const projectRoot = await projectsDb.getProjectPathById(req.params.projectId);
    if (!projectRoot) return res.status(404).json({ error: 'Project not found' });

    const resolved = resolveProjectFile(projectRoot, filePath);
    if (!resolved) return res.status(403).json({ error: 'Path must be under project root' });

    const realCheck = await assertRealPathWithinRoot(projectRoot, resolved);
    if (!realCheck.valid || !realCheck.realPath) return res.status(403).json({ error: realCheck.error || 'Invalid file path' });

    const content = await fsPromises.readFile(realCheck.realPath, 'utf8');
    return res.json({ content, path: resolved });
  } catch (error) {
    const nodeError = toNodeError(error);
    console.error('Error reading file:', error);
    if (nodeError.code === 'ENOENT') return res.status(404).json({ error: 'File not found' });
    if (nodeError.code === 'EACCES') return res.status(403).json({ error: 'Permission denied' });
    return res.status(500).json({ error: nodeError.message });
  }
});

router.get('/projects/:projectId/files/content', async (req, res) => {
  try {
    const filePath = readQueryString(req.query.path);
    if (!filePath) return res.status(400).json({ error: 'Invalid file path' });

    const projectRoot = await projectsDb.getProjectPathById(req.params.projectId);
    if (!projectRoot) return res.status(404).json({ error: 'Project not found' });

    const resolved = resolveProjectFile(projectRoot, filePath);
    if (!resolved) return res.status(403).json({ error: 'Path must be under project root' });

    try {
      await fsPromises.access(resolved);
    } catch {
      return res.status(404).json({ error: 'File not found' });
    }

    const realCheck = await assertRealPathWithinRoot(projectRoot, resolved);
    if (!realCheck.valid || !realCheck.realPath) return res.status(403).json({ error: realCheck.error || 'Invalid file path' });

    res.setHeader('Content-Type', mime.lookup(realCheck.realPath) || 'application/octet-stream');
    const fileStream = fs.createReadStream(realCheck.realPath);
    fileStream.on('error', (error) => {
      console.error('Error streaming file:', error);
      if (!res.headersSent) res.status(500).json({ error: 'Error reading file' });
    });
    fileStream.pipe(res);
    return undefined;
  } catch (error) {
    const nodeError = toNodeError(error);
    console.error('Error serving binary file:', error);
    if (!res.headersSent) return res.status(500).json({ error: nodeError.message });
    return undefined;
  }
});

router.put('/projects/:projectId/file', async (req, res) => {
  try {
    const filePath = typeof req.body?.filePath === 'string' ? req.body.filePath : '';
    const content = req.body?.content;
    if (!filePath) return res.status(400).json({ error: 'Invalid file path' });
    if (content === undefined) return res.status(400).json({ error: 'Content is required' });
    if (typeof content !== 'string') return res.status(400).json({ error: 'Content must be a string' });

    const projectRoot = await projectsDb.getProjectPathById(req.params.projectId);
    if (!projectRoot) return res.status(404).json({ error: 'Project not found' });

    const resolved = resolveProjectFile(projectRoot, filePath);
    if (!resolved) return res.status(403).json({ error: 'Path must be under project root' });

    const realCheck = await assertRealPathWithinRoot(projectRoot, resolved, { allowMissing: true });
    if (!realCheck.valid || !realCheck.realPath) return res.status(403).json({ error: realCheck.error || 'Invalid file path' });

    await fsPromises.writeFile(realCheck.realPath, content, 'utf8');
    return res.json({ success: true, path: resolved, message: 'File saved successfully' });
  } catch (error) {
    const nodeError = toNodeError(error);
    console.error('Error saving file:', error);
    if (nodeError.code === 'ENOENT') return res.status(404).json({ error: 'File or directory not found' });
    if (nodeError.code === 'EACCES') return res.status(403).json({ error: 'Permission denied' });
    return res.status(500).json({ error: nodeError.message });
  }
});

router.get('/projects/:projectId/files', async (req, res) => {
  try {
    const actualPath = await projectsDb.getProjectPathById(req.params.projectId);
    if (!actualPath) return res.status(404).json({ error: 'Project not found' });

    try {
      await fsPromises.access(actualPath);
    } catch {
      return res.status(404).json({ error: `Project path not found: ${actualPath}` });
    }

    return res.json(await getFileTree(actualPath, 10, 0, true));
  } catch (error) {
    const nodeError = toNodeError(error);
    console.error('[ERROR] File tree error:', nodeError.message);
    return res.status(500).json({ error: nodeError.message });
  }
});

export default router;
