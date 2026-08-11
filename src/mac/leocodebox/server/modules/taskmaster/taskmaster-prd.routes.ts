import fs, { promises as fsPromises } from 'node:fs';
import path from 'node:path';

import express from 'express';

import { resolveProjectPathFromId } from './taskmaster.service.js';

const router = express.Router();
const PRD_FILE_NAME_PATTERN = /^[\w\-. ]+\.(txt|md)$/;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function readParam(value: string | string[] | undefined): string {
  return Array.isArray(value) ? value[0] || '' : value || '';
}

function isValidPrdFileName(fileName: string): boolean {
  return PRD_FILE_NAME_PATTERN.test(fileName) && path.basename(fileName) === fileName;
}

router.get('/prd/:projectId', async (req, res) => {
  try {
    const projectId = readParam(req.params.projectId);
    const projectPath = await resolveProjectPathFromId(projectId);
    if (!projectPath) return res.status(404).json({ error: 'Project not found', message: `Project "${projectId}" does not exist` });

    const docsPath = path.join(projectPath, '.taskmaster', 'docs');
    try {
      await fsPromises.access(docsPath, fs.constants.R_OK);
    } catch {
      return res.json({ projectId, prdFiles: [], message: 'No .taskmaster/docs directory found' });
    }

    try {
      const files = await fsPromises.readdir(docsPath);
      const prdFiles: Array<{ name: string; path: string; size: number; modified: string; created: string }> = [];
      for (const file of files) {
        if (!isValidPrdFileName(file)) continue;
        const filePath = path.join(docsPath, file);
        const stats = await fsPromises.stat(filePath);
        if (stats.isFile()) {
          prdFiles.push({ name: file, path: path.relative(projectPath, filePath), size: stats.size, modified: stats.mtime.toISOString(), created: stats.birthtime.toISOString() });
        }
      }
      prdFiles.sort((left, right) => Date.parse(right.modified) - Date.parse(left.modified));
      return res.json({ projectId, projectPath, prdFiles, timestamp: new Date().toISOString() });
    } catch (error) {
      console.error('Error reading docs directory:', error);
      return res.status(500).json({ error: 'Failed to read PRD files', message: errorMessage(error) });
    }
  } catch (error) {
    console.error('PRD list error:', error);
    return res.status(500).json({ error: 'Failed to list PRD files', message: errorMessage(error) });
  }
});

router.post('/prd/:projectId', async (req, res) => {
  try {
    const projectId = readParam(req.params.projectId);
    const fileName = typeof req.body?.fileName === 'string' ? req.body.fileName : '';
    const content = typeof req.body?.content === 'string' ? req.body.content : '';
    if (!fileName || !content) return res.status(400).json({ error: 'Missing required fields', message: 'fileName and content are required' });
    if (!isValidPrdFileName(fileName)) {
      return res.status(400).json({ error: 'Invalid filename', message: 'Filename must end with .txt or .md and contain only alphanumeric characters, spaces, dots, and dashes' });
    }

    const projectPath = await resolveProjectPathFromId(projectId);
    if (!projectPath) return res.status(404).json({ error: 'Project not found', message: `Project "${projectId}" does not exist` });

    const docsPath = path.join(projectPath, '.taskmaster', 'docs');
    const filePath = path.join(docsPath, fileName);
    try {
      await fsPromises.mkdir(docsPath, { recursive: true });
    } catch (error) {
      console.error('Failed to create docs directory:', error);
      return res.status(500).json({ error: 'Failed to create directory', message: errorMessage(error) });
    }

    try {
      await fsPromises.writeFile(filePath, content, 'utf8');
      const stats = await fsPromises.stat(filePath);
      return res.json({ projectId, projectPath, fileName, filePath: path.relative(projectPath, filePath), size: stats.size, created: stats.birthtime.toISOString(), modified: stats.mtime.toISOString(), message: 'PRD file saved successfully', timestamp: new Date().toISOString() });
    } catch (error) {
      console.error('Failed to write PRD file:', error);
      return res.status(500).json({ error: 'Failed to write PRD file', message: errorMessage(error) });
    }
  } catch (error) {
    console.error('PRD create/update error:', error);
    return res.status(500).json({ error: 'Failed to create/update PRD file', message: errorMessage(error) });
  }
});

router.get('/prd/:projectId/:fileName', async (req, res) => {
  try {
    const projectId = readParam(req.params.projectId);
    const fileName = readParam(req.params.fileName);
    if (!isValidPrdFileName(fileName)) return res.status(400).json({ error: 'Invalid filename' });

    const projectPath = await resolveProjectPathFromId(projectId);
    if (!projectPath) return res.status(404).json({ error: 'Project not found', message: `Project "${projectId}" does not exist` });

    const filePath = path.join(projectPath, '.taskmaster', 'docs', fileName);
    try {
      await fsPromises.access(filePath, fs.constants.R_OK);
    } catch {
      return res.status(404).json({ error: 'PRD file not found', message: `File "${fileName}" does not exist` });
    }

    try {
      const [content, stats] = await Promise.all([fsPromises.readFile(filePath, 'utf8'), fsPromises.stat(filePath)]);
      return res.json({ projectId, projectPath, fileName, filePath: path.relative(projectPath, filePath), content, size: stats.size, created: stats.birthtime.toISOString(), modified: stats.mtime.toISOString(), timestamp: new Date().toISOString() });
    } catch (error) {
      console.error('Failed to read PRD file:', error);
      return res.status(500).json({ error: 'Failed to read PRD file', message: errorMessage(error) });
    }
  } catch (error) {
    console.error('PRD read error:', error);
    return res.status(500).json({ error: 'Failed to read PRD file', message: errorMessage(error) });
  }
});

export default router;
