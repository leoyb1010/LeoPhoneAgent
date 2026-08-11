import fs, { promises as fsPromises } from 'node:fs';
import path from 'node:path';

import spawn from 'cross-spawn';
import express from 'express';

import { broadcastTaskMasterTasksUpdate } from '../../utils/taskmaster-websocket.js';

import { resolveProjectPathFromId } from './taskmaster.service.js';

const router = express.Router();

router.post('/parse-prd/:projectId', async (req, res) => {
  try {
    const projectId = Array.isArray(req.params.projectId) ? req.params.projectId[0] : req.params.projectId;
    const fileName = typeof req.body?.fileName === 'string' ? req.body.fileName : 'prd.txt';
    const numTasks = req.body?.numTasks;
    const append = req.body?.append === true;
    const projectPath = await resolveProjectPathFromId(projectId || '');
    if (!projectPath) {
      return res.status(404).json({ error: 'Project not found', message: `Project "${projectId}" does not exist` });
    }

    const prdPath = path.join(projectPath, '.taskmaster', 'docs', fileName);
    try {
      await fsPromises.access(prdPath, fs.constants.F_OK);
    } catch {
      return res.status(404).json({ error: 'PRD file not found', message: `File "${fileName}" does not exist in .taskmaster/docs/` });
    }

    const args = ['task-master-ai', 'parse-prd', prdPath];
    if (numTasks !== undefined && numTasks !== null && String(numTasks).trim()) {
      args.push('--num-tasks', String(numTasks));
    }
    if (append) args.push('--append');
    args.push('--research');

    const parseProcess = spawn('npx', args, { cwd: projectPath, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    parseProcess.stdout?.on('data', (data: Buffer) => { stdout += data.toString(); });
    parseProcess.stderr?.on('data', (data: Buffer) => { stderr += data.toString(); });
    parseProcess.on('close', (code) => {
      if (code === 0) {
        if (req.app.locals.wss) broadcastTaskMasterTasksUpdate(req.app.locals.wss, projectId || '', { source: 'parse-prd' });
        res.json({ projectId, projectPath, prdFile: fileName, message: 'PRD parsed and tasks generated successfully', output: stdout, timestamp: new Date().toISOString() });
        return;
      }
      console.error('Parse PRD failed:', stderr);
      res.status(500).json({ error: 'Failed to parse PRD', message: stderr || stdout, code });
    });
    parseProcess.on('error', (error) => {
      if (!res.headersSent) res.status(500).json({ error: 'Failed to parse PRD', message: error.message });
    });
    parseProcess.stdin?.end();
    return undefined;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('Parse PRD error:', error);
    return res.status(500).json({ error: 'Failed to parse PRD', message });
  }
});

export default router;
