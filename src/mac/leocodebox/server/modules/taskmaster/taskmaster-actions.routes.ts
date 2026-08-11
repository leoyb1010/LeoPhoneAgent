import fs, { promises as fsPromises } from 'node:fs';
import path from 'node:path';

import express from 'express';

import { broadcastTaskMasterProjectUpdate, broadcastTaskMasterTasksUpdate } from '../../utils/taskmaster-websocket.js';

import { runTaskMasterCommand } from './taskmaster-cli.service.js';
import { resolveProjectPathFromId } from './taskmaster.service.js';

const router = express.Router();

function readParam(value: string | string[] | undefined): string {
  return Array.isArray(value) ? value[0] || '' : value || '';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

router.post('/init/:projectId', async (req, res) => {
  try {
    const projectId = readParam(req.params.projectId);
    const projectPath = await resolveProjectPathFromId(projectId);
    if (!projectPath) return res.status(404).json({ error: 'Project not found', message: `Project "${projectId}" does not exist` });

    try {
      await fsPromises.access(path.join(projectPath, '.taskmaster'), fs.constants.F_OK);
      return res.status(400).json({ error: 'TaskMaster already initialized', message: 'TaskMaster is already configured for this project' });
    } catch {
      // The project is ready for initialization.
    }

    const result = await runTaskMasterCommand(projectPath, ['task-master', 'init'], 'yes\n');
    if (result.code !== 0) {
      console.error('TaskMaster init failed:', result.stderr);
      return res.status(500).json({ error: 'Failed to initialize TaskMaster', message: result.stderr || result.stdout, code: result.code });
    }

    if (req.app.locals.wss) {
      broadcastTaskMasterProjectUpdate(req.app.locals.wss, projectId, { hasTaskmaster: true, status: 'initialized' });
    }
    return res.json({ projectId, projectPath, message: 'TaskMaster initialized successfully', output: result.stdout, timestamp: new Date().toISOString() });
  } catch (error) {
    console.error('TaskMaster init error:', error);
    return res.status(500).json({ error: 'Failed to initialize TaskMaster', message: errorMessage(error) });
  }
});

router.post('/add-task/:projectId', async (req, res) => {
  try {
    const projectId = readParam(req.params.projectId);
    const prompt = typeof req.body?.prompt === 'string' ? req.body.prompt : '';
    const title = typeof req.body?.title === 'string' ? req.body.title : '';
    const description = typeof req.body?.description === 'string' ? req.body.description : '';
    const priority = typeof req.body?.priority === 'string' ? req.body.priority : 'medium';
    const dependencies = Array.isArray(req.body?.dependencies)
      ? req.body.dependencies.map(String).join(',')
      : typeof req.body?.dependencies === 'string' ? req.body.dependencies : '';
    if (!prompt && (!title || !description)) {
      return res.status(400).json({ error: 'Missing required parameters', message: 'Either "prompt" or both "title" and "description" are required' });
    }

    const projectPath = await resolveProjectPathFromId(projectId);
    if (!projectPath) return res.status(404).json({ error: 'Project not found', message: `Project "${projectId}" does not exist` });

    const args = ['task-master-ai', 'add-task', '--prompt', prompt || `Create a task titled "${title}" with description: ${description}`];
    if (prompt) args.push('--research');
    if (priority) args.push('--priority', priority);
    if (dependencies) args.push('--dependencies', dependencies);

    const result = await runTaskMasterCommand(projectPath, args);
    if (result.code !== 0) {
      console.error('Add task failed:', result.stderr);
      return res.status(500).json({ error: 'Failed to add task', message: result.stderr || result.stdout, code: result.code });
    }

    if (req.app.locals.wss) broadcastTaskMasterTasksUpdate(req.app.locals.wss, projectId, { source: 'add-task' });
    return res.json({ projectId, projectPath, message: 'Task added successfully', output: result.stdout, timestamp: new Date().toISOString() });
  } catch (error) {
    console.error('Add task error:', error);
    return res.status(500).json({ error: 'Failed to add task', message: errorMessage(error) });
  }
});

export default router;
